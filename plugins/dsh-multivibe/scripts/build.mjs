import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.mjs'],
  outfile: path.join(root, 'lib/index.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['@deepseek-ai/*'], legalComments: 'none',
});
await build({
  absWorkingDir: root,
  entryPoints: ['src/client.jsx'],
  outfile: path.join(root, 'lib/client.js'),
  bundle: true, platform: 'browser', format: 'iife', target: 'es2022',
  jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', legalComments: 'none',
});
