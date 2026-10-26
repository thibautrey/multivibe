# Local face recognition resources

The MultiVibe wrapper is independently implemented. No Cornelius source is included.

`face-api.min.js`, TinyFaceDetector, tiny 68-point landmarks and the converted recognition weights come from face-api.js 0.22.2, commit `8609b25a15f417398a4d2b95dc91985cd1e0c0c3`, by Vincent Mühler (MIT). See `LICENSE.face-api.txt` and the model descriptions at https://github.com/justadudewhohacks/face-api.js/tree/8609b25a15f417398a4d2b95dc91985cd1e0c0c3#models.

The JavaScript bundle includes TensorFlow.js core 1.7.0 (Apache 2.0, `LICENSE.tensorflow.txt`) and tslib (Apache 2.0, `LICENSE.tslib.txt`).

The recognition network is the face-api.js conversion of Davis King's dlib face recognition ResNet weights. The dlib-models repository publishes them under CC0 1.0 (`LICENSE.dlib-models.txt`): https://github.com/davisking/dlib-models/tree/fd81b6308a6a73d4ce08859eb2f4b628a21e27a2#dlib_face_recognition_resnet_model_v1datbz2.

Every downloaded resource and license has an immutable source URL, byte count and SHA-256 in `manifest.json`. The packaging script verifies cached and downloaded bytes before copying. Only these resources are served by the internal URL scheme. Runtime images remain in memory and are erased after processing; this component never uploads images, descriptors or account information.

Matching is a convenience for selecting an enrolled account, with conservative distance/margin checks and repeated observations. It provides no liveness or anti-spoofing guarantee. A configured PIN remains required by the account controller.
