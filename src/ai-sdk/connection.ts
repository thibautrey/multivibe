import { randomBytes } from "node:crypto";
import { PORT, CONTROL_PLANE_PORT, MULTIVIBE_CONTROL_PLANE, V1_EDGE_INTERNAL_JOB_TOKEN } from "../config.js";
export const SDK_INTERNAL_TOKEN = V1_EDGE_INTERNAL_JOB_TOKEN || randomBytes(32).toString("base64url");
export function sdkAdapterBaseUrl(account: { id: string }) {
  const base = process.env.NODE_CONTROL_PLANE_URL ?? `http://127.0.0.1:${MULTIVIBE_CONTROL_PLANE ? CONTROL_PLANE_PORT : PORT}`;
  return `${base.replace(/\/+$/, "")}/internal/ai-sdk/${encodeURIComponent(account.id)}`;
}
