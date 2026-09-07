import type { RequestHandler } from "express";

/** Process-wide budget for single-operator authentication routes. Do not key
 * this on forwarded headers: the native edge proxies requests over loopback. */
export function createAuthRateLimiter(options: {
  limit: number;
  windowMs?: number;
  now?: () => number;
}): RequestHandler {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  let resetAt = 0;
  let count = 0;
  return (_req, res, next) => {
    const time = now();
    if (time >= resetAt) {
      resetAt = time + windowMs;
      count = 0;
    }
    if (count >= options.limit) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - time) / 1000))));
      res.setHeader("Cache-Control", "no-store");
      res.status(429).json({ error: "Too many authentication requests. Try again later." });
      return;
    }
    count++;
    next();
  };
}
