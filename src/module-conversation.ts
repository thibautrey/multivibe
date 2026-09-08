import type { ModuleConversation } from "./module-sdk.js";

/** Hints are authoritative; absence of history is not proof of a one-off call. */
export function inspectModuleConversation(body: any, headers: Record<string, unknown>, sessionId?: string): ModuleConversation {
  const items = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const continuation = Boolean(body?.previous_response_id) || items.some((item: any) =>
    item?.role === "assistant" || item?.role === "tool" || /^(function_call|function_call_output|tool_result)$/.test(item?.type ?? "") ||
    (Array.isArray(item?.content) && item.content.some((part: any) => part?.type === "tool_result" || part?.type === "tool_use")));
  const hint = headers["x-multivibe-conversation-mode"];
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  return {
    phase: continuation ? "continuation" : "start",
    mode: hint === "one-off" || hint === "multi-turn" ? hint : hasTools ? "multi-turn" : "unknown",
    hasTools,
    stateful: Boolean(body?.previous_response_id || body?.conversation),
    sessionId,
    messageCount: items.length || (typeof body?.input === "string" ? 1 : 0),
  };
}
