import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { ManagedExecutor } from "./executor.js";
import { signExecutionGrant, executionBodyDigest, type ExecutionGrant } from "./authorization.js";
import { providerTokenUsage } from "./usage.js";
import type { ExecutionReceipt } from "./journal.js";
import type {ExecutionRecoveryEnvelope} from "./response-recovery.js";
const keys = generateKeyPairSync("ed25519");
const ownership = {ownerId:"11111111-1111-4111-8111-111111111111",epoch:1};
function harness(reply: () => Promise<Response>, operation: ExecutionGrant["operation"] = "responses") {
  const receipts: ExecutionReceipt[] = [];
  const recoveries:(ExecutionRecoveryEnvelope|undefined)[]=[];
  let calls = 0;
  let claimed = false;
  const body = Buffer.from(JSON.stringify({ model: "public/model", input: "hello", max_output_tokens: 8 }));
  const grant: ExecutionGrant = { version: 2, audience: "multivibe-core-managed", attemptId: "a1", reservationId: "r1",
    routeVersionId: "v1", providerId: "mistral", credentialRef: "account-1", model: "public/model", upstreamModel: "upstream",
    operation, stream: false, bodySha256: executionBodyDigest(body), maximumOutputTokens: 8,
    responseRecoveryKeyId:"test-key",responseRecoveryPublicKey:"A5wnJM5Y01mDWCA4MsbAtTGS_l8BI4-JNVWY_KRBH1I",responseRecoveryExpiresAt:120000,
    issuedAt: 1000, expiresAt: 61000 };
  const executor = new ManagedExecutor({ verificationKey: keys.publicKey, maximumRequestBytes: 10000,
    maximumResponseBytes: 10000, executionTimeoutMs: 1000, clock: () => 1001,
    coordination: { async claim() { if (claimed) throw Error("duplicate"); claimed = true; return ownership; } },
    receiptWriter: { async finish(_token,_ownership,receipt,recovery) { receipts.push(receipt);recoveries.push(recovery); } },
    accounts: [{ providerId: "mistral", credentialRef: "account-1", models: new Set(["upstream"]), async chatCompletions(bytes, _signal, authorization) {
      assert.deepEqual(authorization.originalBody, new Uint8Array(body));
      assert.equal(authorization.token, signExecutionGrant(grant, keys.privateKey, 1000));
      assert.deepEqual(authorization.ownership,ownership);
      assert.equal(claimed, true);
      const payload = JSON.parse(Buffer.from(bytes).toString());
      assert.equal(payload.model, "upstream");
      assert.equal(payload.max_tokens, 8);
      calls++;
      return reply();
    } }],
  });
  return { executor, body, token: signExecutionGrant(grant, keys.privateKey, 1000), receipts,recoveries, calls: () => calls };
}
test("managed execution reuses Responses conversion while preserving independent billing usage", async () => {
  const h = harness(async () => Response.json({ model: "upstream", choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } } }));
  const result = await h.executor.execute(h.token, h.body);
  assert.equal((await result.response.json()).object, "response");
  assert.deepEqual((await result.receipt).usage, { inputTokens: "4", outputTokens: "2", totalTokens: "6", cachedInputTokens: "1" });
  assert.equal(h.receipts.length, 1);
  assert.equal(h.recoveries[0]?.keyId,"test-key");
  assert.doesNotMatch(JSON.stringify(h.recoveries[0]),/Hello/);
  await assert.rejects(h.executor.execute(h.token, h.body), /duplicate/);
  assert.equal(h.calls(), 1);
});
test("ambiguous provider failure never retries and durably records uncertainty", async () => {
  const h = harness(async () => { throw Error("secret-provider-error"); });
  const result = await h.executor.execute(h.token, h.body);
  assert.equal(h.calls(), 1);
  assert.equal((await result.receipt).state, "uncertain");
  assert.equal((await result.receipt).usage, null);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.recoveries[0],undefined);
  assert.doesNotMatch(await result.response.text(), /secret-provider-error/);
});
test("compatibility conversion cannot manufacture billable usage", async () => {
  const h = harness(async () => Response.json({ choices: [{ message: { content: "Hi" } }], usage: { prompt_tokens: 3 } }));
  const result = await h.executor.execute(h.token, h.body);
  assert.equal((await result.receipt).usage, null);
  assert.equal((await result.receipt).state, "uncertain");
});
test("usage rejects partial and inconsistent quantities without persisting arbitrary provider fields", () => {
  assert.equal(providerTokenUsage({ usage: { input_tokens: 2 } }), null);
  assert.equal(providerTokenUsage({ usage: { input_tokens: 2, output_tokens: 1, total_tokens: 4 } }), null);
  assert.equal(providerTokenUsage({ usage: { input_tokens: 2, output_tokens: -1 } }), null);
  assert.deepEqual(providerTokenUsage({ usage: { input_tokens: 0, output_tokens: 0, secret: "never copy" } }), { inputTokens: "0", outputTokens: "0" });
});
test("stream cancellation does not discard provider usage or the durable receipt", async () => {
  let finish: ExecutionReceipt | undefined;
  let recovery:ExecutionRecoveryEnvelope|undefined;
  const body = Buffer.from(JSON.stringify({ model: "public/model", input: "hello", stream: true, max_output_tokens: 8 }));
  const grant: ExecutionGrant = { version: 2, audience: "multivibe-core-managed", attemptId: "stream-1", reservationId: "r1",
    routeVersionId: "v1", providerId: "mistral", credentialRef: "account-1", model: "public/model", upstreamModel: "upstream",
    operation: "responses", stream: true, bodySha256: executionBodyDigest(body), maximumOutputTokens: 8,
    responseRecoveryKeyId:"test-key",responseRecoveryPublicKey:"A5wnJM5Y01mDWCA4MsbAtTGS_l8BI4-JNVWY_KRBH1I",responseRecoveryExpiresAt:120000,
    issuedAt: 1000, expiresAt: 61000 };
  const executor = new ManagedExecutor({ verificationKey: keys.publicKey, maximumRequestBytes: 10000,
    maximumResponseBytes: 10000, executionTimeoutMs: 1000, clock: () => 1001,
    coordination: { async claim() {return ownership;} },
    receiptWriter: { async finish(_token,_ownership,receipt,value) { finish = receipt;recovery=value; } },
    accounts: [{ providerId: "mistral", credentialRef: "account-1", models: new Set(["upstream"]), async chatCompletions() {
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(Buffer.from('data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"}}]}\n\n'));
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.enqueue(Buffer.from('data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    } }],
  });
  const result = await executor.execute(signExecutionGrant(grant, keys.privateKey, 1000), body);
  await result.response.body!.cancel();
  const receipt = await result.receipt;
  assert.equal(receipt.state, "completed");
  assert.deepEqual(receipt.usage, { inputTokens: "4", outputTokens: "2" });
  assert.deepEqual(finish, receipt);
  assert.equal(recovery?.contentType,"text/event-stream");
  assert.ok((recovery?.ciphertext.length??0)>0);
});

test("DeepSeek-shaped cache usage survives response conversion in the durable receipt",async()=>{
 const h=harness(async()=>Response.json({choices:[{message:{role:"assistant",content:"Hello"},finish_reason:"stop"}],
  usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6,prompt_cache_hit_tokens:3,prompt_cache_miss_tokens:1}}));
 const result=await h.executor.execute(h.token,h.body);
 assert.equal((await result.receipt).state,"completed");
 assert.equal((await result.receipt).usage?.cachedInputTokens,"3");
 assert.equal(h.receipts[0].usage?.cachedInputTokens,"3");
});

test("JSON and SSE cannot settle output above the signed allowance, including reasoning",async()=>{
 for(const stream of [false,true])for(const output of [8,9]){
  const body=Buffer.from(JSON.stringify({model:"public/model",input:"fixture",stream,max_output_tokens:8}));
  const grant:ExecutionGrant={version:2,audience:"multivibe-core-managed",attemptId:`bound-${stream}-${output}`,reservationId:"r1",
   routeVersionId:"v1",providerId:"mistral",credentialRef:"account-1",model:"public/model",upstreamModel:"upstream",
   operation:"responses",stream,bodySha256:executionBodyDigest(body),maximumOutputTokens:8,
   responseRecoveryKeyId:"test-key",responseRecoveryPublicKey:"A5wnJM5Y01mDWCA4MsbAtTGS_l8BI4-JNVWY_KRBH1I",responseRecoveryExpiresAt:120000,
   issuedAt:1000,expiresAt:61000};
  let persisted:ExecutionReceipt|undefined,recovery:ExecutionRecoveryEnvelope|undefined;
  const usage={prompt_tokens:4,completion_tokens:output,total_tokens:4+output,completion_tokens_details:{reasoning_tokens:5}};
  const executor=new ManagedExecutor({verificationKey:keys.publicKey,maximumRequestBytes:10000,maximumResponseBytes:10000,
   executionTimeoutMs:1000,clock:()=>1001,coordination:{async claim(){return ownership;}},
   receiptWriter:{async finish(_token,_ownership,receipt,value){persisted=receipt;recovery=value;}},
   accounts:[{providerId:"mistral",credentialRef:"account-1",models:new Set(["upstream"]),async chatCompletions(){
    if(stream)return new Response(`data: ${JSON.stringify({object:"chat.completion.chunk",choices:[],usage})}\n\ndata: [DONE]\n\n`,
     {headers:{"content-type":"text/event-stream"}});
    return Response.json({choices:[{message:{role:"assistant",content:"fixture"}}],usage});
   }}]});
  const result=await executor.execute(signExecutionGrant(grant,keys.privateKey,1000),body);
  // Cancellation must not bypass the same budget check during independent drain.
  if(stream)await result.response.body!.cancel();
  const receipt=await result.receipt;
  assert.equal(receipt.state,output===8?"completed":"uncertain");
  assert.equal(receipt.usage?.outputTokens??null,output===8?"8":null);
  assert.deepEqual(persisted,receipt);
  assert.equal(recovery!==undefined,output===8);
 }
});

test("provider HTTP failures with token usage remain durable uncertainty",async()=>{
 for(const status of [400,429,500,503]){
  const h=harness(async()=>Response.json({usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}},{status}));
  const result=await h.executor.execute(h.token,h.body);
  const receipt=await result.receipt;
  assert.equal(result.response.status,502);
  assert.equal(receipt.state,"uncertain");
  assert.equal(receipt.status,status);
  assert.deepEqual(receipt.usage,{inputTokens:"4",outputTokens:"2",totalTokens:"6"});
  assert.deepEqual(h.receipts,[receipt]);
  await assert.rejects(h.executor.execute(h.token,h.body),/duplicate/);
  assert.equal(h.calls(),1);
 }
});
test("provider error payloads cannot manufacture authoritative usage under HTTP 200",async()=>{
 const h=harness(async()=>Response.json({error:{message:"fixture failure"},usage:{prompt_tokens:4,completion_tokens:2}}));
 const result=await h.executor.execute(h.token,h.body);
 assert.equal((await result.receipt).state,"uncertain");
 assert.equal((await result.receipt).usage,null);
});
