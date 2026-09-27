import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { exportDashboardUI } from './export-dashboard-ui.mjs';
import { CORE_CAPABILITIES, CLOUD_CAPABILITIES, dashboardResourceAllowed } from '../packages/ui/src/capabilities.ts';
import { validateSmartAlias, evaluateAliasPolicy, WeightedFairScheduler } from '../packages/ui/src/domain/routing-kernel.ts';

test('Cloud profile refuses all Host resources while retaining shared workspace APIs', () => {
  for (const resource of ['host-update', 'host-update/check', 'host-harnesses', 'modules', 'modules/models', 'team-machine', 'provider-agent/local-worker', 'local-runtimes/discover', 'local-model-preparation', 'model-recommendations?need=coding', 'model-memory', 'cloud/connect', 'grok/import', 'usage/refresh-stale']) {
    assert.equal(dashboardResourceAllowed(resource, CLOUD_CAPABILITIES), false, resource);
    assert.equal(dashboardResourceAllowed(resource, CORE_CAPABILITIES), true, resource);
  }
  for (const resource of ['session','accounts','model-aliases','application-policies','traces?limit=20','stats/usage','/v1/capacity?model=gpt']) assert.equal(dashboardResourceAllowed(resource, CLOUD_CAPABILITIES), true, resource);
  for (const resource of ['../host-update','/admin/accounts','https://localhost/admin/config','//localhost/admin/config']) assert.equal(dashboardResourceAllowed(resource, CLOUD_CAPABILITIES), false, resource);
});
test('routing export validates and evaluates the same rule, and fairly schedules applications', () => {
  const alias = {schemaVersion:2,id:'shared',enabled:true,rules:[{id:'preferred',candidates:[{model:'model-a'}],onNoCapacity:'reject'}]};
  assert.deepEqual(validateSmartAlias(alias), []);
  const request = {application:'test',priority:'interactive',executionMode:'sync',optedIn:true,maxWaitMs:0,modalities:['text'],requiresTools:false,estimatedInputTokens:5,now:0};
  const resource = {accountId:'a',model:'model-a',provider:'openai',location:'cloud',enabled:true,inFlight:0,maxConcurrent:1,freeSlots:1,predictedWaitMs:0,averageLatencyMs:1,confidence:'declared'};
  const result = evaluateAliasPolicy(alias, request, [resource]);
  assert.equal(result.eligible[0]?.resource.accountId,'a');
  const unknown={...resource,freeSlots:undefined,predictedWaitMs:undefined,averageLatencyMs:undefined};
  assert.equal(Number.isFinite(evaluateAliasPolicy(alias,request,[unknown]).eligible[0]?.score),true);
  const constrained={...alias,rules:[{...alias.rules[0],constraints:{maxPredictedWaitMs:100}}]};
  assert.equal(evaluateAliasPolicy(constrained,request,[unknown]).eligible.length,0);
  const scheduler = new WeightedFairScheduler();
  const candidates=[{id:'a',application:'a',priority:'standard'},{id:'b',application:'b',priority:'standard'}];
  const results = Array.from({length:8},()=>scheduler.choose(candidates, app=>app==='a'?3:1));
  assert.equal(results.filter(id=>id==='a').length,6);
});
test('export is deterministic, commit-only, and excludes unrelated files', () => {
  const repository=mkdtempSync(join(tmpdir(),'multivibe-ui-export-'));
  const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8'}).trim();
  try {
    git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
    const paths=['packages/ui/src/index.ts','packages/ui/src/SharedDashboard.tsx','packages/ui/src/App.tsx','packages/ui/src/styles.css','packages/ui/src/workspace-refresh.css','packages/ui/package.json','LICENSE','NOTICE','assets/brand/vector/multivibe-app-icon.svg','src/private.ts'];
    for(const path of paths){mkdirSync(dirname(join(repository,path)),{recursive:true});writeFileSync(join(repository,path),path);}
    git('add','.');git('commit','-qm','fixture');const commit=git('rev-parse','HEAD');
    writeFileSync(join(repository,'packages/ui/src/App.tsx'),'dirty content');
    const first=join(repository,'first.tar.gz'),second=join(repository,'second.tar.gz');
    const lock=exportDashboardUI({repository,commit,output:first});
    exportDashboardUI({repository,commit,output:second});
    assert.deepEqual(readFileSync(first),readFileSync(second));
    const archive=gunzipSync(readFileSync(first)).toString();
    assert(!archive.includes('dirty content'));assert(!archive.includes('src/private.ts'));
    assert(archive.includes('public/assets/brand/multivibe-app-icon.svg'));
    const manifest=JSON.parse(readFileSync(first+'.manifest.json','utf8'));
    assert.equal(manifest.sourceCommit,commit);assert.equal(manifest.files.length,lock.fileCount);
    assert.throws(()=>exportDashboardUI({repository,commit:'HEAD',output:first}),/full 40-character/);
  } finally {rmSync(repository,{recursive:true,force:true});}
});
test('shared browser source has no server or Node import closure', () => {
  const root=new URL('../packages/ui/src/',import.meta.url);
  const inspect=directory=>{
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const path=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
      if(entry.isDirectory())inspect(path);
      else if(/\.(ts|tsx)$/.test(entry.name)){
        const source=readFileSync(path,'utf8');
        assert(!/from\s+['"](?:node:|(?:\.\.\/){3,}src\/)/.test(source),path.pathname);
      }
    }
  };inspect(root);
});
