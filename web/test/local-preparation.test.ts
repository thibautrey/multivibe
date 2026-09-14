import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preparationActive,preparationChatReady,preparationError,preparationBytes,preparationLabels} from '../src/lib/localPreparation';
import type {PreparationJob} from '../../src/local-model-preparation';
test('only tested ready jobs enable chat, never progress or intermediate states',()=>{
  for(const stage of Object.keys(preparationLabels)) {
    const job={stage,chatModelId:'local/model',testedAt:'2026-09-14'} as PreparationJob;
    assert.equal(preparationChatReady(job),stage==='ready');
  }
  assert.equal(preparationChatReady({stage:'ready',chatModelId:'local/model'} as PreparationJob),false);
  assert.equal(preparationChatReady({stage:'ready',testedAt:'2026-09-14'} as PreparationJob),false);
  assert.equal(preparationActive('downloading'),true);
  assert.equal(preparationActive('interrupted'),false);
});
test('API error text and unknown secrets are not shown verbatim',()=>{
  assert.match(preparationError(new Error(JSON.stringify({error:'insufficient_disk'}))),/Free some space/);
  assert.match(preparationError('local_preparation_unavailable'),/not connected/);
  assert.doesNotMatch(preparationError(new Error('token=secret')),/token|secret/);
  assert.match(preparationError('host_restarted_recheck_required'),/not guaranteed/);
});
test('consent volume includes exact byte count and unit',()=>{
  assert.equal(preparationBytes(1073741824),'1 GiB (1,073,741,824 bytes)');
});
