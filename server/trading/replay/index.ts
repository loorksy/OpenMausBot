/** Deterministic XAUUSD replay. This module owns market time and market data.
 * It does not start a turn, own an event bus, or submit an order. */

export { REPLAY_CLOCK_VERSION, createReplayClock, replayInstant } from "./clock.ts";
export type { ReplayAdvance, ReplayClock } from "./clock.ts";

export {
  REPLAY_DATASET_SCHEMA_VERSION,
  REPLAY_ORDERING_RULE,
  createReplayDataset,
} from "./dataset.ts";
export type {
  ReplayDataset,
  ReplayDatasetInput,
  ReplayMarketEvent,
  ReplayPrint,
  ReplayQuote,
} from "./dataset.ts";

export { contentHash, canonicalJson, sha256 } from "./hash.ts";

export { createReplayMarketProvider } from "./provider.ts";
export type { ReplayMarketProvider, ReplayProviderCall } from "./provider.ts";

export {
  REPLAY_CONFIG_VERSION,
  REPLAY_FORMING_POLICY,
  bindReplayGrant,
  createReplaySession,
  expectedClosedOpens,
} from "./session.ts";
export type {
  FormingCandle,
  MarketObservation,
  ReplayDataQuality,
  ReplaySession,
  ReplaySessionOptions,
} from "./session.ts";
