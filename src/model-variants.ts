import type { OpenModel } from './open-model-ranking.js';
export type ModelArtifact = { name: string; format: string; quantization: string; bytes: number | null; files: string[] };
export function quantizationLabel(name: string): string | null {
  return name.match(/(?:^|[.\/_-])((?:IQ|Q)[1-8](?:_[A-Z0-9]+)*|NVFP4|MXFP4|BF16|FP16|F16|FP8|INT[248]|[248]-?BIT)(?=[.\/_-]|$)/i)?.[1]?.toUpperCase() ?? null;
}
/** Calibration, tokenizer, projector and standalone prediction modules are not a runnable model. */
export function isModelWeightArtifact(name:string) {
 const base=(name.split('/').pop()??'').replace(/(?:no[-_]?mtp|without[-_]?mtp)/ig,'');
 return !/(?:^|[._-])(?:imatrix|tokenizer|mmproj|projector|draft|fastmtp|mtp|dspark|lora)(?:[._-]|$)/i.test(base);
}
export function modelArtifacts(model: OpenModel): ModelArtifact[] {
  const gguf = model.files.filter(file => /\.gguf$/i.test(file.name) && isModelWeightArtifact(file.name));
  const groups = new Map<string, typeof gguf>();
  for (const file of gguf) {
    const key = file.name.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i,'');
    groups.set(key,[...(groups.get(key) ?? []),file]);
  }
  if (gguf.length) return [...groups].map(([name,files]) => {
    const shards = files.map(file => file.name.match(/-(\d{5})-of-(\d{5})\.gguf$/i));
    const expected = shards[0] ? Number(shards[0][2]) : 1;
    const complete = files.length === expected && (expected === 1 || (shards.every(s => s && Number(s[2]) === expected) && new Set(shards.map(s=>s?.[1])).size === expected && shards.every(s=>Number(s?.[1])>=1 && Number(s?.[1])<=expected)));
    return {name,format:'GGUF',quantization:quantizationLabel(name) ?? model.quantization ?? 'Unknown',bytes:complete && files.every(f=>f.bytes !== null) ? files.reduce((n,f)=>n+f.bytes!,0) : null,files:files.map(f=>f.name)};
  });
  // Prefer one weight format; never add an alternative .bin copy to safetensors.
  const safetensors = model.files.filter(f=>/\.safetensors$/i.test(f.name));
  const weights = safetensors.length ? safetensors : model.files.filter(f=>/pytorch_model.*\.bin$/i.test(f.name));
  const shards = weights.map(f=>f.name.match(/-(\d{5})-of-(\d{5})\./));
  const expected = shards.find(Boolean)?.[2];
  const complete = !expected || (weights.length === Number(expected) && shards.every(s=>s?.[2]===expected) && new Set(shards.map(s=>s?.[1])).size===Number(expected));
  return [{name:model.id,format:safetensors.length?'Safetensors':weights.length?'PyTorch':model.formats.join(', ') || 'Unknown',quantization:[quantizationLabel(model.id),model.quantization].filter(Boolean).join(' · ') || 'Unknown',bytes:weights.length && complete && weights.every(f=>f.bytes!==null)?weights.reduce((n,f)=>n+f.bytes!,0):null,files:weights.map(f=>f.name)}];
}
export function isModelConversion(model: OpenModel) {
  return ['quantized','converted'].includes(model.relation ?? '') || Boolean(model.quantization) || model.formats.includes('gguf') || /(?:^|[-_])(?:GGUF|GPTQ|AWQ|EXL2)(?:[-_]|$)/i.test(model.id.split('/')[1] ?? '') || Boolean(quantizationLabel(model.id));
}
