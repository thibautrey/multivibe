import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCloudModelCatalog } from './cloud-model-catalog.js';
test('reads every public catalog page without credentials and strips upstream pricing payload', async () => {
  const calls: URL[] = [];
  const fetcher = (async (url: URL, options: RequestInit) => {
    calls.push(url);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(options.redirect, 'error');
    return Response.json(calls.length === 1 ? { data: [{ id: 'a', displayName: 'A', author: 'Author A', aliases: ['alias-a'], multivibeNetwork: null }], nextCursor: 'next' } : { data: [{ id: 'b' }] });
  }) as typeof fetch;
  const models = await readCloudModelCatalog('https://example.com', fetcher);
  assert.deepEqual(models.map(model => model.id), ['a', 'b']);
  assert.equal(models[0]?.author, 'Author A');
  assert.equal(calls[1].searchParams.get('cursor'), 'next');
  assert.equal(models[0].network, false);
});
test('rejects repeated cursors and unavailable catalogs rather than returning partial success', async () => {
  let page = 0;
  await assert.rejects(readCloudModelCatalog('https://example.com', (async () => Response.json({ data: [{ id: String(page++) }], nextCursor: 'cycle' })) as typeof fetch), /pagination/);
  await assert.rejects(readCloudModelCatalog('https://example.com', (async () => new Response('', { status: 503 })) as typeof fetch), /unavailable/);
});
