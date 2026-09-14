import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseOpenModels} from './open-model-catalog.js';
import {pinnedLocalArtifact} from './local-model-artifact.js';
const sha = 'a'.repeat(40), digest = 'b'.repeat(64);
const raw = {id:'publisher/model',private:false,gated:false,pipeline_tag:'text-generation',tags:['license:custom','conversational'],sha,
  siblings:[{rfilename:'weights/model.gguf',size:1024,lfs:{size:1024,sha256:digest}}]};
test('catalog retains immutable artifact evidence and pins download identity',()=>{
  const model=parseOpenModels([raw])[0];
  assert.equal(model.revision,sha);
  assert.deepEqual(pinnedLocalArtifact(model,'weights/model.gguf'),{modelId:raw.id,revision:sha,filename:'weights/model.gguf',bytes:1024,digest:`sha256:${digest}`,url:`https://huggingface.co/publisher/model/resolve/${sha}/weights/model.gguf`});
});
test('unknown or contradictory bytes and hashes cannot become download consent',()=>{
  for(const file of [ {size:1.5}, {size:Number.MAX_SAFE_INTEGER+1}, {lfs:{size:1025,sha256:digest}}, {lfs:{size:1024,sha256:'bad'}}, {lfs:undefined} ]) {
    const model=parseOpenModels([{...raw,siblings:[{...raw.siblings[0],...file}]}])[0];
    assert.throws(()=>pinnedLocalArtifact(model,'weights/model.gguf'),/artifact_metadata_unknown/);
  }
});
test('restricted repositories and moving revisions never produce a pinned artifact',()=>{
  assert.throws(()=>pinnedLocalArtifact(parseOpenModels([{...raw,gated:'auto'}])[0],'weights/model.gguf'),/model_access_required/);
  for(const revision of [undefined,'main','bad']) assert.throws(()=>pinnedLocalArtifact(parseOpenModels([{...raw,sha:revision}])[0],'weights/model.gguf'),/artifact_revision_unknown/);
});
test('unsafe names, duplicate files and split bundles are not single-file quotes',()=>{
  for(const name of ['../model.gguf','/model.gguf','a//model.gguf','a\\model.gguf','a%2fmodel.gguf','model.gguf?x','model-00001-of-00002.gguf','model.safetensors']) {
    const model=parseOpenModels([{...raw,siblings:[{...raw.siblings[0],rfilename:name}]}])[0];
    assert.throws(()=>pinnedLocalArtifact(model,name),/artifact_not_supported/);
  }
  const model=parseOpenModels([{...raw,siblings:[...raw.siblings,...raw.siblings]}])[0];
  assert.throws(()=>pinnedLocalArtifact(model,'weights/model.gguf'),/artifact_not_supported/);
});
