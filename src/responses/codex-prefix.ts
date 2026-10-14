/** Stable Codex startup instructions before session-dependent context.
 * Only the initial, entirely recognized developer run is eligible. History,
 * caller cache boundaries, message identities and incremental requests are opaque.
 */
const SUMMARY = "========= MEMORY_SUMMARY BEGINS";
const PROJECTLESS = "### Projectless Chat\n";

function parts(text: string): Array<[number, string]> | undefined {
  if (text.startsWith("## Memory\n")) {
    const at = text.indexOf(SUMMARY);
    return at < 0 ? [[3, text]] : [[3, text.slice(0, at)], [8, text.slice(at)]];
  }
  if (text.startsWith("<app-context>")) {
    const at = text.indexOf(PROJECTLESS);
    return at >= 0 && text.slice(at).includes("/Users/")
      ? [[5, text.slice(0, at)], [9, text.slice(at)]] : [[5, text]];
  }
  const ranks: Array<[string, number]> = [
    ["<permissions instructions>", 0], ["<multi_agent_mode>", 1],
    ["<collaboration_mode>", 2], ["<multi_agent_role>", 4],
    ["<skills_instructions>", 6], ["<tools>", 7],
    [SUMMARY, 8], [PROJECTLESS, 9], ["<codex_apps_client_time_context>", 10],
  ];
  const rank = ranks.find(([prefix]) => text.startsWith(prefix));
  return rank ? [[rank[1], text]] : undefined;
}

export function optimizeCodexPrefix(body: any): any {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)
      || body.previous_response_id != null || body.conversation != null) return body;
  const input = body.input;
  let start = 0;
  while (input[start]?.role === "system") start++;
  let end = start;
  const chunks: Array<{ rank: number; message: any; text: string }> = [];
  while (input[end]?.role === "developer") {
    const message = input[end++];
    if (Object.keys(message).some(key => !["role", "type", "content"].includes(key))
        || (message.type !== undefined && message.type !== "message")) return body;
    const content = message.content;
    const blocks = typeof content === "string" ? [content] : content;
    if (!Array.isArray(blocks) || !blocks.length) return body;
    for (const block of blocks) {
      if (Array.isArray(content) && typeof block === "string") return body;
      if (typeof block !== "string" && (!block || block.type !== "input_text"
          || Object.keys(block).some(key => !["type", "text"].includes(key)))) return body;
      const text = typeof block === "string" ? block : block.text;
      if (typeof text !== "string") return body;
      const split = parts(text);
      if (!split) return body;
      for (const [rank, part] of split) chunks.push({ rank, message, text: part });
    }
  }
  // Require the complete app/memory/skills startup signature, not just markup.
  if (![3, 5, 6, 8].every(rank => chunks.some(chunk => chunk.rank === rank))) return body;
  const reordered = chunks.sort((a, b) => a.rank - b.rank).map(({ message, text }) => ({
    ...message,
    content: typeof message.content === "string" ? text : [{ type: "input_text", text }],
  }));
  return { ...body, input: [...input.slice(0, start), ...reordered, ...input.slice(end)] };
}
