import express from "express";
import type { HeadroomProvisioner } from "./headroom-provisioner.js";
import { HEADROOM_PLUGIN } from "./headroom-plugin.js";

export type HeadroomRoutesOptions = {
  provisioner?: HeadroomProvisioner;
  /** Persist "do not provision again" when the operator removes Headroom. */
  onUninstalled?: () => Promise<void>;
};

/**
 * Admin routes for the Headroom extension.  The generic module routes still
 * own setting persistence; these routes own the container and the live edge
 * contract, which must never be edited from a request path.
 */
export function headroomRoutes({ provisioner, onUninstalled }: HeadroomRoutesOptions) {
  const router = express.Router();

  const withStatus = async (operation: () => Promise<unknown>, res: express.Response) => {
    if (!provisioner) {
      return res.status(503).json({ error: "Headroom provisioning is unavailable" });
    }
    try {
      await operation();
      return res.json({ module: HEADROOM_PLUGIN, ...(await provisioner.status()) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  router.get("/", async (_req, res) => {
    if (!provisioner) {
      return res.status(503).json({ error: "Headroom provisioning is unavailable" });
    }
    try {
      return res.json({ module: HEADROOM_PLUGIN, ...(await provisioner.status()) });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/install", (_req, res) => withStatus(() => provisioner!.install(), res));
  router.post("/start", (_req, res) => withStatus(() => provisioner!.start(), res));
  router.post("/stop", (_req, res) => withStatus(() => provisioner!.stop(), res));
  router.post("/uninstall", (_req, res) => withStatus(async () => {
    await provisioner!.uninstall();
    await onUninstalled?.();
  }, res));
  router.post("/apply", (req, res) => {
    const token = typeof req.body?.proxyToken === "string" ? req.body.proxyToken.trim() : "";
    return withStatus(() => provisioner!.apply(token || undefined), res);
  });

  router.post("/test", async (req, res) => {
    if (!provisioner) {
      return res.status(503).json({ error: "Headroom provisioning is unavailable" });
    }
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : undefined;
      return res.json({ probe: await provisioner.test(url) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
