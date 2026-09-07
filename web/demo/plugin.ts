import type { Plugin } from "vite";
import { createDemoApi } from "./api";

/** Development-only middleware. No gateway, storage, credentials, or upstream transport. */
export function demoApiPlugin(): Plugin {
  return {
    name: "multivibe-demo-api",
    apply: "serve",
    configureServer(server) {
      const respond = createDemoApi();
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://demo.invalid").pathname;
        if (!/^\/(admin|v1|auth)(\/|$)/.test(path) && path !== "/health") return next();
        try {
          const result = respond(req.method ?? "GET", req.url ?? "/");
          res.statusCode = result.status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-multivibe-demo", "true");
          res.end(req.method === "HEAD" ? undefined : JSON.stringify(result.body));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid demo request" }));
        }
      });
    },
  };
}
