import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTeamDeviceAuth } from './team-device-auth.js';

test('challenge projects public fields only and cancellation disables polling', async () => {
  let requests = 0;
  const session = await startTeamDeviceAuth('github-copilot', (async (_url, init) => {
    requests++;
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ device_code: 'private-device-secret', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
  }) as typeof fetch);
  assert.equal(JSON.stringify(session).includes('private-device-secret'), false);
  assert.equal(session.challenge.userCode, 'ABCD-1234');
  assert.deepEqual(await session.poll(), { status: 'pending', intervalSeconds: 5 });
  assert.equal(requests, 1);
  session.cancel();
  await assert.rejects(session.poll(), /no longer active/);
  assert.equal(requests, 1);
});

test('xAI reuses Core form flow and normalizes it for the isolated proxy', async () => {
  const session = await startTeamDeviceAuth('xai', (async (_url, init) => {
    assert.equal(typeof init?.body, 'string');
    assert.equal(init?.redirect, 'error');
    return Response.json({ device_code: 'private', user_code: 'CODE', verification_uri: 'https://accounts.x.ai/device', expires_in: 900 });
  }) as typeof fetch);
  assert.equal(session.challenge.provider, 'xai');
  session.cancel();
});

test('provider diagnostics are redacted and unsupported providers make no request', async () => {
  const transport = (async () => { throw new Error('access_token=private'); }) as typeof fetch;
  await assert.rejects(startTeamDeviceAuth('xai', transport), { message: 'Team device authorization could not be started' });
  await assert.rejects(startTeamDeviceAuth('openai' as 'xai', transport), /Unsupported/);
});

test('successful Copilot flow preserves renewable credentials and cannot be replayed', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const calls: string[] = [];
  const session = await startTeamDeviceAuth('github-copilot', (async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return Response.json({ device_code: 'private', user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900 });
    if (calls.length === 2) return Response.json({ access_token: 'github-refresh-token' });
    return Response.json({ token: 'copilot-inference-token', expires_at: now / 1000 + 3600, endpoints: { api: 'https://api.business.githubcopilot.com' } });
  }) as typeof fetch);
  t.mock.method(Date, 'now', () => now + 6000);
  const result = await session.poll();
  assert.equal(result.status, 'success');
  if (result.status !== 'success') throw new Error('Expected success');
  assert.equal(result.account.accessToken, 'copilot-inference-token');
  assert.equal(result.account.refreshToken, 'github-refresh-token');
  assert.equal(result.account.baseUrl, 'https://api.business.githubcopilot.com');
  assert.equal(calls.length, 3);
  await assert.rejects(session.poll(), /no longer active/);
  assert.equal(calls.length, 3);
});

test('cancel during pending transport discards a late successful response', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let resolve!: (response: Response) => void;
  let requests = 0;
  const session = await startTeamDeviceAuth('xai', (async () => {
    requests++;
    if (requests === 1) return Response.json({ device_code: 'private', user_code: 'CODE', verification_uri: 'https://accounts.x.ai/device', expires_in: 900 });
    return new Promise<Response>(done => { resolve = done; });
  }) as typeof fetch);
  t.mock.method(Date, 'now', () => now + 6000);
  const pending = session.poll();
  assert.deepEqual(await session.poll(), { status: 'pending', intervalSeconds: 5 });
  session.cancel();
  resolve(Response.json({ access_token: 'late-secret' }));
  await assert.rejects(pending, { message: 'Team device authorization failed' });
  assert.equal(requests, 2);
});

test('OpenCode Team session reuses Core profile discovery through the isolated transport',async(t)=>{
 const now=Date.now();t.mock.method(Date,'now',()=>now);
 const paths:string[]=[];
 const session=await startTeamDeviceAuth('opencode',async(input,init)=>{
  assert.equal(init?.redirect,'error');assert.ok(init?.signal);
  const path=new URL(String(input)).pathname;paths.push(path);
  if(path.endsWith('/auth/device/code'))return Response.json({device_code:'private-device-code',user_code:'ABCD',verification_uri_complete:'/device?user_code=ABCD',expires_in:900,interval:5});
  if(path.endsWith('/auth/device/token'))return Response.json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600});
  if(path.endsWith('/api/user'))return Response.json({id:'user-one',email:'fixture@example.test'});
  if(path.endsWith('/api/orgs'))return Response.json([{id:'org-one',name:'Team'}]);
  if(path.endsWith('/api/config'))return Response.json({config:{provider:{opencode:{api:'https://opencode.ai/inference/openai/v1',options:{apiKey:'{env:OPENCODE_CONSOLE_TOKEN}'}}}}});
  throw Error('Unexpected transport request');
 });
 assert.equal(session.challenge.provider,'opencode');
 assert.equal(JSON.stringify(session).includes('private-device-code'),false);
 assert.deepEqual(await session.poll(),{status:'pending',intervalSeconds:5});
 t.mock.method(Date,'now',()=>now+6000);
 const result=await session.poll();assert.equal(result.status,'success');
 if(result.status!=='success')throw Error('Expected authenticated account');
 assert.equal(result.account.provider,'opencode');assert.equal(result.account.opencodeOrgId,'org-one');
 assert.equal(result.account.refreshToken,'private-refresh');assert.equal(paths.length,5);
 await assert.rejects(session.poll(),/no longer active/);assert.equal(paths.length,5);
});

test('OpenCode Team session cancels and redacts a failed profile lookup',async(t)=>{
 const now=Date.now();t.mock.method(Date,'now',()=>now);
 const session=await startTeamDeviceAuth('opencode',async(input)=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/auth/device/code'))return Response.json({device_code:'private',user_code:'CODE',verification_uri_complete:'/device',expires_in:900,interval:5});
  if(path.endsWith('/auth/device/token'))return Response.json({access_token:'private-access'});
  throw Error('Private account diagnostic');
 });
 t.mock.method(Date,'now',()=>now+6000);
 await assert.rejects(session.poll(),{message:'Team device authorization failed'});
 await assert.rejects(session.poll(),/no longer active/);
});
