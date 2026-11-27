import express from "express";
import crypto from "node:crypto";
import type { AccountStore } from "../../store.js";
import type { User, UserQuota } from "../../types.js";
import { getAuth, requireAdmin } from "../../auth-context.js";
import {
  hashPassword,
  isValidEmail,
  isValidPassword,
  newInvite,
  normalizeEmail,
  normalizePlan,
  publicUser,
} from "../../users.js";

type CreateUsersRouterOptions = { store: AccountStore };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanName(value: unknown): string | undefined {
  const name = typeof value === "string" ? value.trim().slice(0, 120) : "";
  return name || undefined;
}

function cleanRole(value: unknown): "admin" | "member" | undefined {
  return value === "admin" || value === "member" ? value : undefined;
}

/** Empty means unrestricted. Model ids keep their provider prefix. */
function cleanAllowedModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const model = entry.trim().slice(0, 200);
    if (!model || model === "__proto__" || model === "constructor" || model === "prototype") continue;
    seen.add(model);
    if (seen.size >= 1000) break;
  }
  return [...seen];
}

function cleanStatus(value: unknown): "active" | "suspended" | undefined {
  return value === "active" || value === "suspended" ? value : undefined;
}

function mergeQuota(existing: UserQuota, raw: Record<string, unknown>): UserQuota {
  const next: UserQuota = { ...existing };
  if (raw.period === "day" || raw.period === "month" || raw.period === "total") {
    next.period = raw.period;
  }
  for (const key of ["creditUsd", "maxTokens", "maxRequests"] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null || value === "") {
      delete next[key];
      continue;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    if (numeric === 0 && key !== "creditUsd") {
      delete next[key];
      continue;
    }
    next[key] = numeric;
  }
  return next;
}

function invitePath(token: string): string {
  return `/?invite=${encodeURIComponent(token)}`;
}

export function createAdminUsersRouter({ store }: CreateUsersRouterOptions) {
  const router = express.Router();
  router.use(requireAdmin);

  const activeAdmins = () =>
    store
      .getCachedUsers()
      .filter((user) => user.role === "admin" && user.status === "active");

  router.get("/", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json({ users: store.getCachedUsers().map(publicUser) });
  });

  router.post("/", async (req, res) => {
    const body = asRecord(req.body);
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: "invalid_email" });
    if (await store.findUserByEmail(email)) {
      return res.status(409).json({ error: "email_in_use" });
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (password && !isValidPassword(password)) {
      return res.status(400).json({ error: "weak_password" });
    }
    const invite = password ? undefined : newInvite();
    const now = Date.now();
    const quota = mergeQuota({ period: "month" }, asRecord(body.quota));
    const plan = normalizePlan(body.plan);
    if ("allowedModels" in body && !Array.isArray(body.allowedModels)) {
      return res.status(400).json({ error: "invalid_allowed_models" });
    }
    const allowedModels = cleanAllowedModels(body.allowedModels);
    const user: User = {
      id: crypto.randomUUID(),
      email,
      ...(cleanName(body.name) ? { name: cleanName(body.name)! } : {}),
      role: cleanRole(body.role) ?? "member",
      status: "active",
      ...(password ? { password: await hashPassword(password) } : {}),
      quota,
      ...(plan ? { plan } : {}),
      ...(allowedModels?.length ? { allowedModels } : {}),
      usage: { periodStart: undefined, requests: 0, tokens: 0, costUsd: 0, updatedAt: now },
      createdAt: now,
      updatedAt: now,
      ...(invite
        ? {
            invite: {
              tokenHash: invite.tokenHash,
              createdAt: now,
              expiresAt: invite.expiresAt,
            },
          }
        : {}),
    };
    await store.addUser(user);
    res.status(201).json({
      user: publicUser(user),
      ...(invite ? { invitePath: invitePath(invite.token), inviteToken: invite.token } : {}),
    });
  });

  router.patch("/:id", async (req, res) => {
    const id = req.params.id;
    const before = await store.findUser(id);
    if (!before) return res.status(404).json({ error: "not_found" });
    const body = asRecord(req.body);
    const auth = getAuth(req);
    const patch: Partial<User> = {};

    if ("email" in body) {
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) return res.status(400).json({ error: "invalid_email" });
      const conflict = await store.findUserByEmail(email);
      if (conflict && conflict.id !== id) {
        return res.status(409).json({ error: "email_in_use" });
      }
      patch.email = email;
    }
    if ("name" in body) {
      const name = cleanName(body.name);
      patch.name = name;
    }
    if ("role" in body) {
      const role = cleanRole(body.role);
      if (!role) return res.status(400).json({ error: "invalid_role" });
      if (
        before.role === "admin" &&
        role !== "admin" &&
        activeAdmins().filter((user) => user.id !== id).length === 0
      ) {
        return res.status(409).json({ error: "last_admin" });
      }
      patch.role = role;
    }
    if ("status" in body) {
      const status = cleanStatus(body.status);
      if (!status) return res.status(400).json({ error: "invalid_status" });
      if (
        before.role === "admin" &&
        status !== "active" &&
        activeAdmins().filter((user) => user.id !== id).length === 0
      ) {
        return res.status(409).json({ error: "last_admin" });
      }
      if (auth?.userId === id && status !== "active") {
        return res.status(409).json({ error: "cannot_suspend_self" });
      }
      patch.status = status;
    }
    if ("password" in body) {
      const password = typeof body.password === "string" ? body.password : "";
      if (!password) {
        patch.password = undefined;
      } else {
        if (!isValidPassword(password)) {
          return res.status(400).json({ error: "weak_password" });
        }
        patch.password = await hashPassword(password);
        patch.invite = null;
      }
    }
    if ("quota" in body) {
      patch.quota = mergeQuota(before.quota, asRecord(body.quota));
    }
    if ("plan" in body) {
      // `null` or `{ mode: "usage" }` removes the subscription windows.
      patch.plan = normalizePlan(body.plan) ?? { mode: "usage" };
      if (!patch.plan.windows?.length) patch.plan = { mode: patch.plan.mode };
    }
    if ("allowedModels" in body) {
      const allowedModels = cleanAllowedModels(body.allowedModels);
      if (!allowedModels) return res.status(400).json({ error: "invalid_allowed_models" });
      patch.allowedModels = allowedModels.length ? allowedModels : undefined;
    }

    const updated = await store.patchUser(id, patch);
    if (!updated) return res.status(404).json({ error: "not_found" });
    res.json({ user: publicUser(updated) });
  });

  router.delete("/:id", async (req, res) => {
    const id = req.params.id;
    const auth = getAuth(req);
    if (auth?.userId === id) {
      return res.status(409).json({ error: "cannot_delete_self" });
    }
    const user = await store.findUser(id);
    if (!user) return res.status(404).json({ error: "not_found" });
    if (user.role === "admin" && activeAdmins().filter((entry) => entry.id !== id).length === 0) {
      return res.status(409).json({ error: "last_admin" });
    }
    // Cascade: a deleted user must not leave working credentials behind, and
    // their provider accounts are personal data.
    for (const key of store.getCachedProxyApiKeys()) {
      if (key.ownerId === id) await store.deleteProxyApiKey(key.id);
    }
    for (const account of store.getCachedAccounts()) {
      if (account.ownerId === id) await store.deleteAccount(account.id);
    }
    await store.deleteUser(id);
    res.json({ ok: true });
  });

  router.post("/:id/invite", async (req, res) => {
    const user = await store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    const invite = newInvite();
    const updated = await store.patchUser(user.id, {
      invite: {
        tokenHash: invite.tokenHash,
        createdAt: Date.now(),
        expiresAt: invite.expiresAt,
      },
    });
    res.json({
      user: updated ? publicUser(updated) : undefined,
      invitePath: invitePath(invite.token),
      inviteToken: invite.token,
    });
  });

  router.post("/:id/credit", async (req, res) => {
    const user = await store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    const amount = Number(asRecord(req.body).amountUsd);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return res.status(400).json({ error: "invalid_amount" });
    }
    const updated = await store.grantUserAllowance(user.id, amount, {
      actor: getAuth(req)?.userId ?? "admin",
    });
    res.json({ user: updated ? publicUser(updated) : undefined });
  });

  // Prepaid balance, kept apart from the period allowance so a purchase never
  // expires with the quota period.
  router.post("/:id/wallet", async (req, res) => {
    const user = await store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    const body = asRecord(req.body);
    const amount = Number(body.amountUsd);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      return res.status(400).json({ error: "invalid_amount" });
    }
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
    const updated = await store.adjustUserWallet(user.id, amount, {
      kind: amount > 0 ? "topup" : "debit",
      actor: getAuth(req)?.userId ?? "admin",
      ...(note ? { note } : {}),
    });
    if (!updated) return res.status(400).json({ error: "invalid_amount" });
    res.json({
      user: publicUser(updated),
      walletUsd: updated.walletUsd ?? 0,
      ledger: updated.creditLedger ?? [],
    });
  });

  router.get("/:id/credits", async (req, res) => {
    const user = await store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    res.json({
      walletUsd: user.walletUsd ?? 0,
      ledger: user.creditLedger ?? [],
    });
  });

  router.post("/:id/reset-usage", async (req, res) => {
    const user = await store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    const updated = await store.resetUserUsage(user.id);
    res.json({ user: updated ? publicUser(updated) : undefined });
  });

  // Recovery path for a lost device: an admin can revoke a passkey, but the
  // credential can only be created by its owner from their own browser.
  router.delete("/:id/passkeys/:passkeyId", async (req, res) => {
    const user = await store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    const passkeys = (user.passkeys ?? []).filter(
      (passkey) => passkey.id !== req.params.passkeyId,
    );
    const updated = await store.patchUser(user.id, { passkeys });
    res.json({ user: updated ? publicUser(updated) : undefined });
  });

  return router;
}
