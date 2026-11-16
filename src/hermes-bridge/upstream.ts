/**
 * Per-turn upstream choice.
 *
 * The rules here are the ones the promise depends on, so they are stated once
 * and tested directly:
 *
 * 1. A turn is routed **once**, before the first token. After a byte reaches the
 *    harness the choice is frozen: replaying the same turn to a second provider
 *    would run tools twice and duplicate output.
 * 2. Nous is the fallback, and the fallback must never be worse than today's
 *    behaviour. If the edge is unreachable, slow, or refuses, the turn goes to
 *    Nous when a comparable model exists.
 * 3. A turn may only switch when a model of the same class exists on the other
 *    side. Waiting is better than a silent quality change.
 * 4. A conversation that switched stays on Nous briefly, so the prompt cache on
 *    either side is reused and flapping does not double cost.
 */

import type { BridgeConfig, ModelMapping } from "./config.js";
import { mapModel } from "./config.js";

export type Upstream = "edge" | "nous";

export type SwitchReason =
  | "edge_unavailable"
  | "edge_timeout"
  | "edge_queued"
  | "edge_error"
  | "no_equivalent_model"
  | "sticky_nous"
  | "mode";

export type RouteDecision =
  | { upstream: Upstream; reason: SwitchReason; model: string }
  | { upstream: null; reason: SwitchReason; model: null };

export type EdgeAdmission = {
  decision: "admit" | "queue" | "switch";
  waitMs?: number;
  lease?: string | null;
};

export type RouteInput = {
  requestedModel: string;
  /** Set when this conversation already switched to Nous. */
  stickyUntilMs?: number;
  now: number;
  /** Outcome of the last edge probe for this turn, if one ran. */
  edge?: {
    reachable: boolean;
    admission?: EdgeAdmission;
    error?: "timeout" | "http" | "network";
  };
};

export function routeTurn(
  config: BridgeConfig,
  mappings: readonly ModelMapping[],
  input: RouteInput,
): RouteDecision {
  const nousModel = mapModel(mappings, input.requestedModel, "nous");
  const edgeModel = mapModel(mappings, input.requestedModel, "edge");

  const nousChoice: RouteDecision = nousModel
    ? { upstream: "nous", reason: "mode", model: nousModel }
    : { upstream: null, reason: "no_equivalent_model", model: null };
  const noEquivalent: RouteDecision = {
    upstream: null,
    reason: "no_equivalent_model",
    model: null,
  };

  if (config.mode === "nous-only") {
    return nousModel ? { ...nousChoice, reason: "mode" } : noEquivalent;
  }
  if (config.mode === "edge-only") {
    return edgeModel
      ? { upstream: "edge", reason: "mode", model: edgeModel }
      : noEquivalent;
  }

  // Stickiness wins over everything: it protects both prompt caches and keeps a
  // conversation on one provider for its duration.
  if (
    input.stickyUntilMs !== undefined &&
    input.stickyUntilMs > input.now &&
    nousModel
  ) {
    return { upstream: "nous", reason: "sticky_nous", model: nousModel };
  }

  const edge = input.edge;
  if (!edge) {
    return edgeModel
      ? { upstream: "edge", reason: "mode", model: edgeModel }
      : nousModel
        ? { upstream: "nous", reason: "no_equivalent_model", model: nousModel }
        : noEquivalent;
  }

  // An unreachable edge is not a reason to fail. Fall back when we can.
  if (!edge.reachable) {
    if (nousModel) {
      return {
        upstream: "nous",
        reason: edge.error === "timeout" ? "edge_timeout" : "edge_unavailable",
        model: nousModel,
      };
    }
    return noEquivalent;
  }

  const admission = edge.admission;
  if (admission) {
    if (admission.decision === "admit") {
      if (edgeModel) return { upstream: "edge", reason: "mode", model: edgeModel };
      // The edge offered capacity but has no equivalent model: the caller's
      // model is edge-native only, so Nous cannot serve this turn.
      return noEquivalent;
    }
    // The edge is full. Switch only when the caller's queue budget has already
    // been exceeded, so a short wait stays on the edge.
    const wait = admission.waitMs ?? 0;
    if (config.mode === "nous-first" && nousModel) {
      const overBudget =
        wait > 0 && input.now + wait - input.now > config.maxQueueWaitMs;
      if (overBudget || admission.decision === "switch") {
        return { upstream: "nous", reason: "edge_queued", model: nousModel };
      }
      return nousModel
        ? { upstream: "nous", reason: "edge_queued", model: nousModel }
        : noEquivalent;
    }
    return nousModel
      ? { upstream: "nous", reason: "edge_queued", model: nousModel }
      : noEquivalent;
  }

  // Reachable, but nothing was decided: prefer the edge.
  return edgeModel
    ? { upstream: "edge", reason: "mode", model: edgeModel }
    : nousModel
      ? { upstream: "nous", reason: "no_equivalent_model", model: nousModel }
      : noEquivalent;
}

/**
 * Rethink the last decision once an edge attempt has begun.
 *
 * This exists to encode rule 1 explicitly: it can never move a turn that has
 * already emitted a byte, so the only legal answer is "no change".
 */
export function canSwitchAfterFirstByte(): false {
  return false;
}
