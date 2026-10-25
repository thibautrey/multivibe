import type { HarnessCapability } from "./types.js";

export type HarnessFeatureItem = {
  id: string;
  section: "actions" | "modes" | "commands" | "skills" | "plugins" | "agents" | "tools" | "mcp" | "hooks" | "capabilities";
  name: string;
  description?: string;
  action: "goal" | "compact" | "configure" | "insert" | "inspect";
  value?: string;
  subject?: string;
};

const SECTIONS = ["modes", "commands", "skills", "plugins", "agents", "tools", "mcp", "hooks"] as const;
export const FEATURE_SUBJECTS = [...SECTIONS];

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
const objects = (value: unknown): any[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object") : [];
function rows(subject: typeof SECTIONS[number], value: any): any[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (subject === "skills") {
    const nested = objects(value.data).flatMap(v => objects(v.skills));
    return objects(value.skills).length ? objects(value.skills) : nested;
  }
  if (subject === "modes") return objects(value.availableModes).length ? objects(value.availableModes) : objects(value.data);
  if (subject === "plugins" && objects(value.marketplaces).length) return objects(value.marketplaces).flatMap(v => objects(v.plugins));
  for (const key of [subject, subject === "mcp" ? "mcpServers" : "", subject === "commands" ? "availableCommands" : "", "data"]) {
    if (key && Array.isArray(value[key])) return value[key];
  }
  if (subject === "tools" && strings(value.ids).length) return value.ids;
  const candidate = value[subject] ?? (subject === "mcp" ? value.servers : undefined);
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return Object.entries(candidate).map(([id, detail]) => ({ id, ...(detail && typeof detail === "object" ? detail : {}) }));
  return [];
}

const safeText = (value: unknown, max = 500): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
function item(subject: typeof SECTIONS[number], row: any, index: number, harnessId: string): HarnessFeatureItem | null {
  if (typeof row === "string") row = { name: row, id: row };
  if (!row || typeof row !== "object") return null;
  const rawName = row.name ?? row.title ?? row.displayName ?? row.label ?? row.command ?? row.mode ?? row.id ?? row.value;
  const name = safeText(rawName, 200);if (!name) return null;
  const value = safeText(row.mode ?? row.id ?? row.value ?? row.name, 256) ?? name;
  const description = safeText(row.description ?? row.detail ?? row.summary ?? row.hint ?? row.argumentHint);
  let action: HarnessFeatureItem["action"] = "inspect", actionValue: string | undefined, targetSubject: string | undefined = subject;
  if (subject === "modes") { action = "configure";actionValue = value; }
  else if (subject === "commands") { action = "insert";actionValue = `/${name.replace(/^\//u, "")} `; }
  else if (subject === "skills") {
    action = "insert";
    const skill = name.replace(/^[/\$]/u, "");
    actionValue = harnessId === "openai-codex" ? `$${skill} ` : harnessId === "pi" ? `/skill:${skill} ` : `/${skill} `;
  } else if (["plugins", "agents", "tools", "mcp"].includes(subject)) {
    action = "insert";
    const noun = subject === "mcp" ? "MCP server" : subject.slice(0, -1);
    actionValue = `Use the ${name} ${noun} for this request. `;
  }
  const section = subject === "modes" && /^(?:plan|planning)$/iu.test(value) ? "actions" : subject;
  return { id: `${subject}:${value}:${index}`, section, name, ...(description ? { description } : {}), action,
    ...(actionValue ? { value: actionValue } : {}), ...(targetSubject ? { subject: targetSubject } : {}) };
}

export function harnessFeatures(harnessId: string, capabilities: Record<string, HarnessCapability>, inspected: Record<string, unknown>): HarnessFeatureItem[] {
  const result: HarnessFeatureItem[] = [];
  if (harnessId === "openai-codex") result.push({id:"action:goal",section:"actions",name:"Goal",description:"Set a goal for this conversation to keep pursuing",action:"goal"});
  if (capabilities.compaction?.available || rows("commands", inspected.commands).some(row => String(row?.name ?? row).replace(/^\//u, "") === "compact")) {
    result.push({id:"action:compact",section:"actions",name:"Compact context",description:"Ask the harness to reduce the active context",action:"compact"});
  }
  for (const subject of SECTIONS) {
    rows(subject, inspected[subject]).slice(0, 500).forEach((row, index) => {const normalized=item(subject,row,index,harnessId);if(normalized)result.push(normalized);});
  }
  const represented = new Set(result.map(v => v.subject).filter(Boolean));
  for (const [name, capability] of Object.entries(capabilities).sort(([a],[b]) => a.localeCompare(b))) {
    if (!capability.available || ["sessions","streaming","attachments"].includes(name) || represented.has(name)) continue;
    result.push({id:`capability:${name}`,section:"capabilities",name,description:capability.reason??capability.support,action:"inspect",subject:name});
  }
  return [...new Map(result.map(value => [value.id, value])).values()];
}
