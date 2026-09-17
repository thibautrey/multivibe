import { createHash } from "node:crypto";
import type { TraceEntry } from "./traces.js";

export function sessionKeyFor(
  application: string | undefined,
  sessionId: string,
): string {
  const scope = typeof application === "string" ? application.trim() : "";
  return createHash("sha256")
    .update(`${scope}\u0000${sessionId}`)
    .digest("hex")
    .slice(0, 24);
}

export function sessionKeyOf(
  trace: Pick<TraceEntry, "sessionKey" | "codexSessionId" | "application">,
): string | undefined {
  if (trace.sessionKey) return trace.sessionKey;
  const sessionId = trace.codexSessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
  return sessionKeyFor(trace.application, sessionId.trim());
}
