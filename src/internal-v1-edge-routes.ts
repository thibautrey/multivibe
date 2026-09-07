import crypto from "node:crypto";
import express from "express";
import type { AccountStore } from "./store.js";
import type { Account } from "./types.js";

type TokenPersistenceBody = {
  expectedAccessToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  chatgptAccountId?: string;
  email?: string;
  needsTokenRefresh: boolean;
  authBlockedUntil?: number | null;
};

export type InternalV1EdgeRouterOptions = {
  store: AccountStore;
  internalToken: string;
};

function secretEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseTokenPersistenceBody(value: unknown): TokenPersistenceBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.expectedAccessToken !== "string" ||
    typeof body.accessToken !== "string" ||
    body.accessToken.length === 0
  ) {
    return null;
  }
  if (hasOwn(body, "refreshToken") && typeof body.refreshToken !== "string") {
    return null;
  }
  if (
    hasOwn(body, "expiresAt") &&
    (typeof body.expiresAt !== "number" ||
      !Number.isFinite(body.expiresAt) ||
      body.expiresAt < 0)
  ) {
    return null;
  }
  if (typeof body.needsTokenRefresh !== "boolean") {
    return null;
  }
  if (
    hasOwn(body, "chatgptAccountId") &&
    typeof body.chatgptAccountId !== "string"
  ) {
    return null;
  }
  if (hasOwn(body, "email") && typeof body.email !== "string") return null;
  if (
    hasOwn(body, "authBlockedUntil") &&
    body.authBlockedUntil !== null &&
    (typeof body.authBlockedUntil !== "number" ||
      !Number.isFinite(body.authBlockedUntil) ||
      body.authBlockedUntil < 0)
  ) {
    return null;
  }
  return body as TokenPersistenceBody;
}

export function createInternalV1EdgeRouter(
  options: InternalV1EdgeRouterOptions,
): express.Router {
  const router = express.Router();

  router.use((req, res, next) => {
    const token = req.header("x-multivibe-internal-token");
    if (!token || !secretEqual(token, options.internalToken)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  router.post("/accounts/:id/token", async (req, res, next) => {
    try {
      const body = parseTokenPersistenceBody(req.body);
      if (!body) {
        return res.status(400).json({
          error: {
            code: "invalid_request",
            message: "Invalid token persistence payload",
          },
        });
      }

      const state: Account["state"] = {};
      state.needsTokenRefresh = body.needsTokenRefresh;
      if (hasOwn(body, "authBlockedUntil")) {
        state.authBlockedUntil = body.authBlockedUntil ?? undefined;
      }
      const patch: Pick<Account, "accessToken"> &
        Partial<
          Pick<
            Account,
            | "refreshToken"
            | "expiresAt"
            | "chatgptAccountId"
            | "email"
            | "state"
          >
        > = {
        accessToken: body.accessToken,
      };
      if (hasOwn(body, "refreshToken")) patch.refreshToken = body.refreshToken;
      if (hasOwn(body, "expiresAt")) patch.expiresAt = body.expiresAt;
      if (hasOwn(body, "chatgptAccountId")) {
        patch.chatgptAccountId = body.chatgptAccountId;
      }
      if (hasOwn(body, "email")) patch.email = body.email;
      if (Object.keys(state).length > 0) patch.state = state;

      const result = options.store.patchAccountTokenIfCurrent(
        req.params.id,
        body.expectedAccessToken,
        patch,
      );
      if (result.status === "not_found") {
        return res.status(404).json({
          error: { code: "account_not_found", message: "Account not found" },
        });
      }
      if (result.status === "conflict") {
        // The in-memory token may have been changed by an administrator while
        // Rust was refreshing. Make that winning value durable before Rust
        // reloads the shared file after the CAS conflict.
        await options.store.flushIfDirty();
        return res.status(409).json({
          error: {
            code: "stale_access_token",
            message: "Account access token changed",
          },
        });
      }

      await options.store.flushIfDirty();
      res.setHeader("cache-control", "no-store");
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
