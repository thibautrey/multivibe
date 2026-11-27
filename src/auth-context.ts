import type express from "express";

/**
 * Identity attached by the dashboard guard. `admin` can manage everything;
 * `member` is scoped to their own accounts, keys, traces and quota.
 */
export type AuthIdentity = {
  role: "admin" | "member";
  /** Absent for the legacy admin-token login. */
  userId?: string;
  via: "token" | "session";
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthIdentity;
    }
  }
}

export function getAuth(req: express.Request): AuthIdentity | undefined {
  return req.auth;
}

export function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (getAuth(req)?.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

/**
 * The user id a request must be constrained to, or `undefined` for an admin
 * (no constraint). Never trust a `userId` query parameter from a member.
 */
export function scopedUserId(req: express.Request): string | undefined {
  const auth = getAuth(req);
  return auth && auth.role !== "admin" ? auth.userId : undefined;
}

export function ownsResource(req: express.Request, ownerId: string | undefined): boolean {
  const auth = getAuth(req);
  // The dashboard guard always sets `auth`; routers mounted without it are
  // trusted internal callers (and tests) and keep the unrestricted view.
  if (!auth || auth.role === "admin") return true;
  return Boolean(ownerId) && ownerId === auth.userId;
}
