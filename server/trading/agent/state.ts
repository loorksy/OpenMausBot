import type { Decision } from "../../../shared/trading/decision.ts";
import type { Evidence } from "../../../shared/trading/evidence.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import type { MarketSnapshot } from "../../../shared/trading/snapshot.ts";
import type { XauUsdContext } from "../../../shared/trading/context.ts";
import type { VersionManifest } from "../../../shared/trading/version-manifest.ts";
import type { MarketClock } from "../infrastructure/market_data/model.ts";
import type { ToolGate } from "./catalog.ts";
import type { XauUsdTurnGrant } from "./grant.ts";

/** Mutable investigation record for one OpenMausBot turn. It is not a second runtime. */
export interface XauUsdSessionState {
  readonly grant: XauUsdTurnGrant;
  readonly manifest: VersionManifest;
  readonly clock: MarketClock;
  /** Market clock at the moment of the call. Replay sessions advance without replacing this object. */
  now(): MarketClock;
  readonly gate: ToolGate;
  readonly modelId: string;
  readonly modelFallback?: {
    readonly from: string;
    readonly to: string;
    readonly policyVersion: string;
  };
  activeRuntimeEventId: string;
  readonly snapshots: Map<string, MarketSnapshot>;
  readonly contexts: Map<string, XauUsdContext>;
  readonly evidence: Map<string, Evidence>;
  readonly decisions: Map<string, Decision>;
  readonly intents: Map<string, OrderIntent>;
}
