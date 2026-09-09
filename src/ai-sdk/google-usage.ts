import type {LanguageModelV4Usage} from "@ai-sdk/provider";
/** Google SDK normalization defaults absent native counters to zero. Preserve
 * incomplete/contradictory evidence instead of presenting invented token usage.
 * This validates token accounting, not model pricing or execution authority. */
export function googleUsageEligible(usage:LanguageModelV4Usage):boolean {
 const raw=usage.raw;
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return false;
 const count=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
 if(!count(raw.promptTokenCount)||!count(raw.candidatesTokenCount)||!count(raw.totalTokenCount))return false;
 for(const key of ["thoughtsTokenCount","cachedContentTokenCount","toolUsePromptTokenCount"]){
  if(raw[key]!==undefined&&!count(raw[key]))return false;
 }
 // SDK totals omit provider tool-use prompt work. Do not silently drop it.
 if((raw.toolUsePromptTokenCount??0)!==0)return false;
 const thinking=Number(raw.thoughtsTokenCount??0),cached=Number(raw.cachedContentTokenCount??0);
 const output=raw.candidatesTokenCount+thinking,total=raw.promptTokenCount+output;
 return Number.isSafeInteger(output)&&Number.isSafeInteger(total)&&raw.totalTokenCount===total
  &&cached<=raw.promptTokenCount&&usage.inputTokens.total===raw.promptTokenCount
  &&usage.inputTokens.noCache===raw.promptTokenCount-cached&&usage.inputTokens.cacheRead===cached
  &&usage.outputTokens.total===output&&usage.outputTokens.reasoning===thinking;
}
