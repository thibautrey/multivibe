import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { parseOpenModels } from '../../src/open-model-catalog.js';
import { rankOpenModels } from '../../src/open-model-ranking.js';

// Exercise the actual component, including its children, with an older API payload.
const require = createRequire(new URL('../package.json', import.meta.url));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/components/tabs/ModelDetailPanel.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
});
const componentModule = { exports: {} as { ModelDetailPanel?: unknown } };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, componentModule, componentModule.exports);

const model = parseOpenModels([{ id: 'publisher/model', private: false, gated: false, pipeline_tag: 'text-generation', tags: ['conversational', 'license:mit'] }])[0];
const row = rankOpenModels({ models: [model], checkedAt: '', stale: false, source: 'test', version: 'test' }, 'writing', 'recommended')[0];
function render(recommendationSources: unknown) {
  const payload = JSON.parse(JSON.stringify({ ...row, recommendationSources }));
  return renderToStaticMarkup(createElement(componentModule.exports.ModelDetailPanel, { row: payload, supported: false, onPrepare() {} }));
}
test('model details render when legacy API responses omit sources or return null', () => {
  for (const sources of [undefined, null, [], {}]) {
    const html = render(sources);
    assert.match(html, /publisher\/model/);
    assert.match(html, /Cost &amp; privacy/);
    assert.doesNotMatch(html, /<summary>Sources<\/summary>/);
  }
});
test('model details preserve available recommendation sources', () => {
  const html = render([{ id: 'publisher', url: 'https://huggingface.co/publisher/model', label: 'Publisher evidence', kind: 'publisher', checkedAt: '2026-09-16T00:00:00Z' }]);
  assert.match(html, /<summary>Sources<\/summary>/);
  assert.match(html, /Publisher evidence/);
  assert.match(html, /Checked 2026-09-16/);
});
