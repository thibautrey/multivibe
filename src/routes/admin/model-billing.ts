import express from "express";
import type { AccountStore } from "../../store.js";
import { requireAdmin } from "../../auth-context.js";
import { setModelBillingOverrides } from "../../model-pricing.js";
import { normalizeOffPeakSchedule, setOffPeakSchedule } from "../../off-peak.js";
import type { ModelBillingRate } from "../../types.js";

type CreateModelBillingRouterOptions = { store: AccountStore };

const RESERVED_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  // JSON.stringify calls `toJSON`, so a model with that id would break store
  // persistence instead of pricing anything.
  "toJSON",
  "toString",
  "valueOf",
  "hasOwnProperty",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const MAX_RATE = 1_000_000;

function price(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_RATE ? amount : null;
}

/** A rate needs a finite standard input and output price. */
function cleanRate(raw: unknown): ModelBillingRate | null {
  const body = asRecord(raw);
  const inputPer1M = price(body.inputPer1M);
  const outputPer1M = price(body.outputPer1M);
  if (inputPer1M === null || outputPer1M === null) return null;
  const rate: ModelBillingRate = { inputPer1M, outputPer1M };
  if (body.cachedInputPer1M !== undefined && body.cachedInputPer1M !== null && body.cachedInputPer1M !== "") {
    const cached = price(body.cachedInputPer1M);
    if (cached === null) return null;
    rate.cachedInputPer1M = cached;
  }
  if (body.offPeak !== undefined && body.offPeak !== null) {
    const offPeak = asRecord(body.offPeak);
    // An empty object means "no off-peak rate" rather than free usage.
    if (Object.keys(offPeak).length > 0) {
      const offInput = price(offPeak.inputPer1M);
      const offOutput = price(offPeak.outputPer1M);
      if (offInput === null || offOutput === null) return null;
      const entry: NonNullable<ModelBillingRate["offPeak"]> = {
        inputPer1M: offInput,
        outputPer1M: offOutput,
      };
      if (offPeak.cachedInputPer1M !== undefined && offPeak.cachedInputPer1M !== null && offPeak.cachedInputPer1M !== "") {
        const cached = price(offPeak.cachedInputPer1M);
        if (cached === null) return null;
        entry.cachedInputPer1M = cached;
      }
      rate.offPeak = entry;
    }
  }
  return rate;
}

function cleanModel(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

/**
 * Billed rates are an operator concern: they set what users are charged, in
 * USD per million input, cached-input and output tokens. Upstream discovery
 * keeps working underneath, so clearing a rate restores the catalog estimate.
 * Off-peak rates only replace the standard rate inside the weekly calendar.
 */
export function createAdminModelBillingRouter({ store }: CreateModelBillingRouterOptions) {
  const router = express.Router();
  router.use(requireAdmin);

  const read = () => ({ ...(store.getCachedSettings().modelBilling ?? {}) });

  router.get("/", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json({ billing: read(), schedule: store.getCachedSettings().offPeak ?? null });
  });

  router.put("/", async (req, res) => {
    const body = asRecord(req.body);
    const model = cleanModel(body.model);
    if (!model || RESERVED_KEYS.has(model)) {
      return res.status(400).json({ error: "invalid_model" });
    }
    const rate = cleanRate(body);
    if (!rate) return res.status(400).json({ error: "invalid_rate" });
    const billing = { ...read(), [model]: rate };
    const settings = await store.patchSettings({ modelBilling: billing });
    setModelBillingOverrides(settings.modelBilling);
    res.json({ billing: settings.modelBilling ?? {}, model, rate });
  });

  router.delete("/", async (req, res) => {
    const model = cleanModel(req.body?.model ?? req.query.model);
    if (!model || RESERVED_KEYS.has(model)) {
      return res.status(400).json({ error: "invalid_model" });
    }
    const billing = read();
    delete billing[model];
    const settings = await store.patchSettings({
      modelBilling: Object.keys(billing).length ? billing : undefined,
    });
    setModelBillingOverrides(settings.modelBilling);
    res.json({ billing: settings.modelBilling ?? {} });
  });

  router.put("/schedule", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
    const candidate = "schedule" in body ? body.schedule : body;
    const schedule = normalizeOffPeakSchedule(candidate);
    if (!schedule) {
      return res.status(400).json({ error: "invalid_schedule" });
    }
    const stored = schedule.enabled || Object.keys(schedule.days).length
      ? schedule
      : undefined;
    const settings = await store.patchSettings({ offPeak: stored });
    setOffPeakSchedule(settings.offPeak);
    res.json({ schedule: settings.offPeak ?? null });
  });

  return router;
}
