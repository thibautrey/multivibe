import {createAnthropic} from "@ai-sdk/anthropic";
/** Shared native codec factory; no account storage, routing or retries. */
export function createAnthropicCodec(model:string,apiKey:string,baseURL:string,fetchImpl?:typeof fetch){
 return createAnthropic({apiKey,baseURL,fetch:fetchImpl}).languageModel(model);
}
