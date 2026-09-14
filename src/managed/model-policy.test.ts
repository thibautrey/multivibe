import test from "node:test";
import assert from "node:assert/strict";
import {managedModelAllowed,parseManagedModelPolicy} from "./model-policy.js";
test("model policy stays restrictive unless deployment explicitly delegates IDs to Cloud",()=>{
 const models=new Set(["existing"]);
 assert.equal(parseManagedModelPolicy(undefined),"allowlist");
 assert.equal(managedModelAllowed({models},"new-model"),false);
 assert.equal(managedModelAllowed({models},"existing"),true);
 assert.equal(managedModelAllowed({models,modelPolicy:"cloud_authorized"},"new-model"),true);
 for(const id of ["", "../model", "*", "model?url=other",null,"x".repeat(257)]){
  assert.equal(managedModelAllowed({models,modelPolicy:"cloud_authorized"},id),false);
 }
 for(const policy of [null,true,"*","all"] )assert.throws(()=>parseManagedModelPolicy(policy));
});
