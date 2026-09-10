import { createPublicKey, sign, verify, type KeyLike } from 'node:crypto';

export const TEAM_MACHINE_LEASE_MS = 48 * 60 * 60 * 1000;
export type MachineTransport = 'private_network' | 'cloud_relay';
export type MachinePolicy = {
  version: 'team-machine-v1'; organizationId: string; instanceId: string;
  revision: number; consentId: string; runtimeId: string;
  transport: MachineTransport; endpoint: string | null; enabled: boolean;
  models: Array<{ id: string; members: string[] }>;
  keys: Array<{ digest: string; memberId: string }>;
  maxConcurrent: number; issuedAt: number; expiresAt: number; entitlementEndsAt: number;
};
export type SignedMachinePolicy = { policy: MachinePolicy; signature: string; keyId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exact(value: object, keys: string[]) {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error('machine_policy_fields');
}
export function validateMachinePolicy(p: MachinePolicy, now: number): void {
  if (!p || typeof p !== 'object') throw new Error('machine_policy_invalid');
  exact(p, ['version','organizationId','instanceId','revision','consentId','runtimeId','transport','endpoint','enabled','models','keys','maxConcurrent','issuedAt','expiresAt','entitlementEndsAt']);
  if (p.version !== 'team-machine-v1' || !UUID.test(p.organizationId) || !UUID.test(p.instanceId)
    || !UUID.test(p.consentId) || !Number.isSafeInteger(p.revision) || p.revision < 1
    || typeof p.runtimeId !== 'string' || p.runtimeId.length < 1 || p.runtimeId.length > 160
    || typeof p.enabled !== 'boolean' || !['private_network','cloud_relay'].includes(p.transport)
    || !Number.isSafeInteger(p.maxConcurrent) || p.maxConcurrent < 1 || p.maxConcurrent > 128) throw new Error('machine_policy_invalid');
  if (![p.issuedAt,p.expiresAt,p.entitlementEndsAt].every(Number.isSafeInteger)
    || p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt
    || p.expiresAt - p.issuedAt > TEAM_MACHINE_LEASE_MS || p.expiresAt > p.entitlementEndsAt) throw new Error('machine_policy_expired');
  if (p.transport === 'private_network') {
    if (!p.endpoint) throw new Error('machine_private_endpoint_required');
    const url = new URL(p.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('machine_private_tls_required');
  } else if (p.endpoint !== null) throw new Error('machine_relay_endpoint_forbidden');
  if (!Array.isArray(p.models) || p.models.length > 256 || !Array.isArray(p.keys) || p.keys.length > 10000) throw new Error('machine_policy_limits');
  const models = new Set<string>();
  for (const model of p.models) {
    exact(model, ['id','members']);
    if (typeof model.id !== 'string' || !model.id || model.id.length > 256 || models.has(model.id)
      || !Array.isArray(model.members) || model.members.length > 10000 || !model.members.every(id => UUID.test(id))) throw new Error('machine_model_invalid');
    models.add(model.id);
  }
  const keys = new Set<string>();
  for (const key of p.keys) {
    exact(key, ['digest','memberId']);
    if (!/^[a-f0-9]{64}$/.test(key.digest) || !UUID.test(key.memberId) || keys.has(key.digest)) throw new Error('machine_key_invalid');
    keys.add(key.digest);
  }
}
export function issueMachinePolicy(policy: MachinePolicy, keyId: string, privateKey: KeyLike, now = Date.now()): SignedMachinePolicy {
  validateMachinePolicy(policy, now);
  return { policy, keyId, signature: sign(null, Buffer.from(JSON.stringify(policy)), privateKey).toString('base64url') };
}
export function verifyMachinePolicy(envelope: SignedMachinePolicy, trusted: Record<string,string>, now = Date.now()): MachinePolicy {
  exact(envelope, ['policy','signature','keyId']);
  const pem = trusted[envelope.keyId];
  if (!pem || typeof envelope.signature !== 'string') throw new Error('machine_signature_invalid');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(JSON.stringify(envelope.policy)), key, Buffer.from(envelope.signature,'base64url'))) throw new Error('machine_signature_invalid');
  validateMachinePolicy(envelope.policy, now);
  return envelope.policy;
}
