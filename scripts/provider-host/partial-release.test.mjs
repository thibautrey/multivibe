import assert from 'node:assert/strict';
import test from 'node:test';
import { builds, quotaBlocked, selectArtifacts } from './select-release-artifacts.mjs';
import { validateReleaseArchives, validateMacVerification } from './release-archive-policy.mjs';
const jobs = builds.map((b, i) => ({name: b.job, id: i + 1, conclusion: 'success', steps: [{conclusion: 'success'}]}));
const artifacts = builds.map((b, i) => ({name: b.artifact, id: i + 10, expired: false}));
const quota = {annotation_level: 'failure', message: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.'};

test('complete builds retain every native platform', () => {
  assert.equal(selectArtifacts(jobs, artifacts).selected.length, 4);
});
test('runner quota omissions preserve successful self-hosted builds', () => {
  const blocked = jobs.map((job, i) => i ? {...job, conclusion: 'failure', steps: []} : job);
  const result = selectArtifacts(blocked, artifacts.slice(0,1), {2:[quota],3:[quota],4:[quota]});
  assert.equal(result.selected[0].name, 'provider-host-linux');
  assert.equal(result.omitted.length, 3);
  assert.equal(selectArtifacts(blocked.map(job => ({...job, conclusion: 'success'})), artifacts.slice(0,1), {2:[quota],3:[quota],4:[quota]}).omitted.length, 3);
});
test('a single unavailable architecture does not discard a successful sibling', () => {
  const blocked = jobs.map((job, i) => i === 2 ? {...job, conclusion: 'failure', steps: []} : job);
  const result = selectArtifacts(blocked, artifacts.filter((_,i) => i !== 2), {3:[quota]});
  assert.equal(result.selected.length, 3);
  assert.equal(result.omitted.length, 1);
});
test('explicit self-hosted mode skips hosted jobs without relying on quota APIs', () => {
  assert.equal(selectArtifacts(jobs.slice(0,1), artifacts.slice(0,1), {}, true).omitted.length, 3);
  assert.throws(() => selectArtifacts([], [], {}, true), /build-linux/);
});
test('build, missing artifact, cancellation, and unknown admission failures block release', () => {
  for (const failure of [
    {conclusion:'failure',steps:[{conclusion:'failure'}]},
    {conclusion:'success',steps:[{conclusion:'failure'}]}, // continue-on-error must never conceal a failed build
    {conclusion:'cancelled',steps:[]},
    {conclusion:'failure',steps:[]},
  ]) {
    const changed = jobs.map((job,i) => i === 1 ? {...job,...failure} : job);
    assert.throws(() => selectArtifacts(changed, artifacts, {2:[quota]}));
  }
  assert.throws(() => selectArtifacts(jobs, []), /artifact/);
  assert.equal(quotaBlocked({conclusion:'failure',steps:[]}, [{annotation_level:'failure',message:'Runner could not be provisioned'}]), false);
});
test('partial signing policy rejects empty, mixed-version, duplicate and unsupported archives', () => {
  validateReleaseArchives(['multivibe-host_1.2.3_linux_amd64.tar.gz']);
  validateReleaseArchives(['multivibe-host_1.2.3_linux_amd64.tar.gz', 'multivibe-host_1.2.3_darwin_arm64.dmg']);
  for (const names of [[], ['multivibe-host_1.2.3_linux_arm64.tar.gz'], ['multivibe-host_1.2.3_linux_amd64.tar.gz','multivibe-host_2.0.0_windows_amd64.zip'], ['multivibe-host_1.2.3_linux_amd64.tar.gz','multivibe-host_1.2.3_linux_amd64.tar.gz']]) assert.throws(() => validateReleaseArchives(names));
});
test('Mac verification must bind readiness, source commit, target and exact archive digest', () => {
  const name = 'multivibe-host_1.2.3_darwin_arm64.dmg', digest = 'a'.repeat(64), commit = 'b'.repeat(40);
  const report = {version:'1.2.3', platform:'darwin', architecture:'arm64', sourceCommit:commit, archiveSha256:digest, verified:true, releaseReady:true, sourceTreeDirty:false, runtimeChecked:false};
  assert.equal(validateMacVerification(report,name,digest,commit), report);
  for (const patch of [{sourceCommit:'c'.repeat(40)}, {archiveSha256:'c'.repeat(64)}, {releaseReady:false}, {sourceTreeDirty:true}, {platform:'linux'}, {architecture:'amd64'}]) assert.throws(() => validateMacVerification({...report,...patch},name,digest,commit));
});


test('self-hosted-only releases retain registered native Macs and require their builds to succeed', () => {
  const selected = selectArtifacts(jobs, artifacts, {}, true, ['build-macos-arm64', 'build-macos-amd64']);
  assert.equal(selected.selected.length, 3);
  assert.equal(selected.omitted.length, 1);
  const failed = jobs.map(job => job.name === 'build-macos-arm64' ? {...job,conclusion:'failure',steps:[]} : job);
  assert.throws(() => selectArtifacts(failed, artifacts.filter(a => a.name !== 'provider-host-macos-arm64'), {2:[quota]}, true, ['build-macos-arm64']), /build-macos-arm64/);
});
