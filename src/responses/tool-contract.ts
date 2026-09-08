// This bridge implements function tools. Other tool dialects need an explicit
// adapter; accepting them and silently removing them changes client intent.
export function validateChatToolContract(body: any): string | undefined {
  const tools = body?.tools ?? [];
  if (!Array.isArray(tools)) return "tools must be an array";
  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (tool?.type !== "function") return `tools[${index}].type is unsupported by the Chat Completions bridge`;
    const name = (tool.function ?? tool)?.name;
    if (typeof name !== "string" || !name.trim()) return `tools[${index}] requires a function name`;
    names.add(name);
  }
  const choice = body?.tool_choice;
  if (choice === undefined || choice === "auto" || choice === "none") return;
  if (choice === "required") return names.size ? undefined : "tool_choice required needs at least one tool";
  if (choice?.type === "function" && names.has(choice.name ?? choice.function?.name)) return;
  return "tool_choice must select an available function or be auto, none, or required";
}
