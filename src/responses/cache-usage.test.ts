import assert from "node:assert/strict";
import test from "node:test";
import { responseObjectToChatCompletion, chatCompletionObjectToResponseObject, chatCompletionObjectToSSE,
 createResponsesToChatCompletionStreamState, convertResponsesSSEToChatCompletionSSE } from "./converters.js";
const payloads = (s: string) => s.split("\n").filter(l => l.startsWith("data: ") && !l.includes("[DONE]")).map(l => JSON.parse(l.slice(6)));
test("JSON and SSE bridges preserve cache hits, explicit zero and unknown observations", () => {
 for (const cached of [0, 70, undefined]) {
  const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
   ...(cached !== undefined ? { input_tokens_details: { cached_tokens: cached }, output_tokens_details: { reasoning_tokens: 0 } } : {}) };
  const response = { id: 'r', object: 'response', output: [{type:'message',role:'assistant',content:[{type:'output_text',text:'hello'}]}], usage };
  const chat = responseObjectToChatCompletion(response, 'test');
  assert.equal(chat.usage.prompt_tokens_details?.cached_tokens, cached);
  assert.equal(Object.hasOwn(chat.usage, 'prompt_tokens_details'), cached !== undefined);
  const back = chatCompletionObjectToResponseObject(chat);
  assert.deepEqual(back.usage, usage);
  const chunks = payloads(chatCompletionObjectToSSE(chat));
  assert.deepEqual(chunks.at(-1).usage, chat.usage);
  const state = createResponsesToChatCompletionStreamState('test');
  const stream = convertResponsesSSEToChatCompletionSSE(`data: ${JSON.stringify({type:'response.completed',response})}\n\n`, state);
  const terminal = payloads(stream || '').find(chunk => chunk.usage);
  assert.deepEqual(terminal?.usage, chat.usage);
 }
});
