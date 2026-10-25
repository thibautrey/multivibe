import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessResources, writeHarnessResource } from "./resources.js";
import type { HarnessSession } from "./types.js";

test("native memory editing checks ownership, source revision and symlinks",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-memory-test-"));const previous=process.env.HERMES_HOME;process.env.HERMES_HOME=root;
  t.after(()=>{if(previous===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=previous;fs.rmSync(root,{recursive:true,force:true});});
  const session={harnessId:"hermes-agent",workspace:root} as HarnessSession;
  const resource=harnessResources(session,"memory")[0];assert.equal(resource.exists,false);
  writeHarnessResource(session,{kind:"memory",path:resource.path,sha256:resource.sha256,text:"first"});
  const current=harnessResources(session,"memory")[0];assert.equal(current.text,"first");
  assert.throws(()=>writeHarnessResource(session,{kind:"memory",path:current.path,sha256:"stale",text:"overwrite"}),/changed/u);
  writeHarnessResource(session,{kind:"memory",path:current.path,sha256:current.sha256,text:"second"});
  assert.equal(fs.readFileSync(current.path+".before-multivibe","utf8"),"first");assert.equal(fs.statSync(current.path).mode&0o777,0o600);
  const secret=path.join(root,"private.txt");fs.writeFileSync(secret,"private");fs.unlinkSync(current.path);fs.symlinkSync(secret,current.path);
  assert.throws(()=>writeHarnessResource(session,{kind:"memory",path:current.path,sha256:current.sha256,text:"overwrite"}),/not an editable/u);
  assert.equal(fs.readFileSync(secret,"utf8"),"private");
});
test("instruction discovery reports ordered sources without claiming to replace native composition",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-instructions-test-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,"project","sub");fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(root,"project","AGENTS.md"),"parent");fs.writeFileSync(path.join(workspace,"AGENTS.md"),"child");
  const resources=harnessResources({harnessId:"pi",workspace} as HarnessSession,"instructions",root);assert.deepEqual(resources.map(v=>v.text),["parent","child"]);assert.ok(resources.every(v=>!v.writable));
});
