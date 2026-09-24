import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = new URL('../MultiVibeChat/Resources/PiAgentCore.js', import.meta.url);
const result = await build({ absWorkingDir: directory, entryPoints: ['bridge.mjs'], bundle: true,
  platform: 'browser', format: 'iife', target: 'safari18', define: { global: 'globalThis' },
  tsconfigRaw: { compilerOptions: { alwaysStrict: true } }, minify: true, legalComments: 'inline', write: false, metafile: true });
const forbidden = Object.keys(result.metafile.inputs).filter(path => /node_modules\/(openai|@anthropic-ai|@aws-sdk|@google)\//.test(path));
if (forbidden.length) throw new Error('Native-only bundle unexpectedly includes provider SDKs: ' + forbidden.join(', '));
const content = result.outputFiles[0].text;
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content) throw new Error('Pi bundle is stale: run npm run build');
} else await writeFile(output, content);
console.log(`Pi Agent Core browser bundle: ${Buffer.byteLength(content)} bytes`);

const packages = [...new Set(Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([path]) => path)).map(path => path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))].sort();
let notices = '';
for (const name of packages) {
  const root = join(directory, 'node_modules', name);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const licenseFile = (await readdir(root)).find(name => /^licen[sc]e(?:[.-].*)?$/i.test(name));
  const license = licenseFile ? await readFile(join(root, licenseFile), 'utf8')
    : name.startsWith('@earendil-works/') ? await readFile(join(directory, 'licenses/pi.txt'), 'utf8') : null;
  if (!license) throw new Error('Missing license for ' + name);
  notices += `${name}@${pkg.version} (${pkg.license})\n${license.trim()}\n\n`;
}
const licenses = new URL('../MultiVibeChat/Resources/PiAgentCore-LICENSES.txt', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(licenses, 'utf8') !== notices) throw new Error('Pi license notices are stale');
} else await writeFile(licenses, notices);
