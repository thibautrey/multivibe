import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BASELINE_SHA256 = '9a8a1ba36fd84ad2bac897b09d39e21fddb791e619adc9d9838007f8a433648e';
const PATCHED_SHA256 = 'e5de3e3e406f094dfd5d36e766f49730cf2ac28b95e961045213c291163a0c2b';
const MARKER = '// MULTIVIBE-103: runtime context belongs to the current turn.';
const digest = text => createHash('sha256').update(text).digest('hex');

export function patchRhoPromptCache(source) {
  if (digest(source) === PATCHED_SHA256) return source;
  if (digest(source) !== BASELINE_SHA256) throw new Error('Unsupported Rho source; audit the new version before patching.');
  function replaceOnce(from, to) {
    if (source.split(from).length !== 2) throw new Error('Rho patch boundary is ambiguous.');
    source = source.replace(from, to);
  }
  replaceOnce('function buildMetaPrompt(opts: MetaPromptOptions): string {',
    'function buildMetaPrompt(opts: MetaPromptOptions): { instructions: string; runtime: string } {');
  replaceOnce('\tsections.push(runtimeLines.join("\\n"));',
    '\tconst runtime = runtimeLines.join("\\n");');
  replaceOnce('\treturn sections.join("\\n\\n");\n}\n\n// ═',
    '\treturn { instructions: sections.join("\\n\\n"), runtime };\n}\n\n// ═');
  replaceOnce('\t\t\tmetaPrompt,\n\t\t\tcachedBootstrapPrompt,',
    '\t\t\tmetaPrompt.instructions,\n\t\t\tcachedBootstrapPrompt,');
  replaceOnce('\t\t\t\tsystemPrompt: `${event.systemPrompt}\\n\\n${sections.join("\\n\\n")}`,',
    '\t\t\t\t' + MARKER + '\n\t\t\t\tsystemPrompt: `${event.systemPrompt}\\n\\n${sections.join("\\n\\n")}`,\n\t\t\t\tmessage: { customType: "rho-runtime-context", content: metaPrompt.runtime, display: false },');
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mode] = process.argv.slice(2);
  if (!file || (mode && mode !== '--apply')) throw new Error('Usage: node scripts/patch-rho-prompt-cache.mjs /absolute/path/to/rho/extensions/rho/index.ts [--apply]');
  const before = readFileSync(file, 'utf8');
  const after = patchRhoPromptCache(before);
  if (mode === '--apply' && before !== after) {
    const backup = file + '.prefix-cache-v1.bak';
    if (existsSync(backup)) throw new Error('Backup already exists; inspect it before applying.');
    writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
    writeFileSync(file, after);
  }
  console.log(JSON.stringify({ changed: before !== after, applied: mode === '--apply', beforeSha256: digest(before), afterSha256: digest(after) }));
}
