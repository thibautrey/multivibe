// One transient handoff; never persisted or included in normal menu summaries.
type DeviceSignIn = { id: string; provider: string; code: string; expiresAt: number };
let pending: DeviceSignIn | undefined;
export function publishDeviceSignIn(event: DeviceSignIn): void {
  if (!/^[A-Za-z0-9 -]{1,64}$/.test(event.code) || !Number.isFinite(event.expiresAt)) return;
  pending = { ...event, expiresAt: Math.min(event.expiresAt, Date.now() + 60_000) };
}
export function takeDeviceSignIn(now = Date.now()): DeviceSignIn | undefined {
  const event = pending;
  pending = undefined;
  return event && event.expiresAt > now ? event : undefined;
}
