/* Independent MultiVibe integration. No camera access, networking, persistence, or identity inference beyond enrolled descriptors. */
(() => {
  'use strict';
  const bridge = payload => window.webkit?.messageHandlers?.multivibeFace?.postMessage(payload);
  let generation = 0;
  let busy = false;
  let canvas = null;
  const clear = () => {
    generation++;
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
  };
  function quality(image, box) {
    const { x, y, width, height } = box;
    if (Math.min(width, height) < 80) return 'Rapprochez-vous légèrement.';
    if (x < 5 || y < 5 || x + width > image.width - 5 || y + height > image.height - 5) return 'Gardez le visage entier dans le cadre.';
    const context = image.getContext('2d', { willReadFrequently: true });
    const crop = context.getImageData(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), Math.floor(width), Math.floor(height));
    const gray = (px, py) => {
      const index = (py * crop.width + px) * 4;
      return crop.data[index] * 0.299 + crop.data[index + 1] * 0.587 + crop.data[index + 2] * 0.114;
    };
    let sum = 0, laplace = 0, laplaceSquared = 0, count = 0;
    for (let py = 2; py < crop.height - 2; py += 2) for (let px = 2; px < crop.width - 2; px += 2) {
      const value = gray(px, py), edge = gray(px - 1, py) + gray(px + 1, py) + gray(px, py - 1) + gray(px, py + 1) - 4 * value;
      sum += value; laplace += edge; laplaceSquared += edge * edge; count++;
    }
    if (!count || sum / count < 40 || sum / count > 215) return 'Éclairez le visage sans contre-jour.';
    if (laplaceSquared / count - (laplace / count) ** 2 < 20) return 'Restez immobile pour une image nette.';
    return null;
  }
  window.multivibeFace = {
    clear,
    async analyze(id, dataURL) {
      if (busy) return bridge({ type: 'sample', id, issue: 'Veuillez patienter.' });
      busy = true;
      const current = generation;
      let image;
      try {
        if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/jpeg;base64,') || dataURL.length > 2_000_000) throw new Error('invalid image');
        image = new Image();
        image.src = dataURL;
        await image.decode();
        if (current !== generation) return;
        canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const results = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.7 }))
          .withFaceLandmarks(true).withFaceDescriptors();
        if (current !== generation) return;
        if (results.length !== 1) return bridge({ type: 'sample', id, issue: results.length ? 'Placez une seule personne devant la caméra.' : 'Regardez la caméra, visage bien éclairé.', faces: results.length });
        const issue = quality(canvas, results[0].detection.box);
        const descriptor = Array.from(results[0].descriptor);
        if (descriptor.length !== 128 || descriptor.some(value => !Number.isFinite(value))) throw new Error('invalid descriptor');
        bridge({ type: 'sample', id, faces: 1, ...(issue ? { issue } : { descriptor }) });
      } catch (_) {
        if (current === generation) bridge({ type: 'sample', id, issue: 'La reconnaissance est indisponible.', failed: true });
      } finally {
        if (image) image.src = '';
        if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
        busy = false;
      }
    },
  };
  (async () => {
    // The CPU backend works in an invisible WKWebView and never asks for WebGL or a remote worker.
    await faceapi.tf.setBackend('cpu');
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('./models'),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri('./models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('./models'),
    ]);
    bridge({ type: 'ready' });
  })().catch(() => bridge({ type: 'failed' }));
})();
