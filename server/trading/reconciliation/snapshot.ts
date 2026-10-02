import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { seal } from "../../../shared/trading/ids.ts";
import { contentHash } from "../replay/hash.ts";

/** One immutable MetaApi observation. It is not rewritten when a later
 * observation arrives, and it is not proof that an internal request succeeded. */
export const BROKER_SNAPSHOT_VERSION = "xauusd-broker-snapshot-1" as const;

export const METAAPI_RECONCILIATION_PROVIDER = "metaapi-cloud" as const;

export type BrokerChannel = "read" | "unavailable";

export interface BrokerChannels {
  readonly orders: BrokerChannel;
  readonly deals: BrokerChannel;
  readonly positions: BrokerChannel;
  readonly account: BrokerChannel;
}

export interface BrokerOrderObservation {
  readonly orderId: string;
  readonly clientId: string | null;
  readonly symbol: string;
  readonly volume: number;
  readonly direction: "LONG" | "SHORT" | null;
  readonly state: string | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
}

export interface BrokerDealObservation {
  readonly dealId: string;
  readonly orderId: string | null;
  readonly clientId: string | null;
  readonly positionId: string | null;
  readonly symbol: string;
  readonly volume: number;
  readonly price: number | null;
}

export interface BrokerPositionObservation {
  readonly positionId: string;
  readonly symbol: string;
  readonly volume: number;
  readonly direction: "LONG" | "SHORT" | null;
}

export interface BrokerAccountObservation {
  readonly balance: number | null;
  readonly equity: number | null;
  readonly margin: number | null;
  readonly currency: string | null;
}

export interface BrokerAccountSnapshot {
  readonly schemaVersion: typeof BROKER_SNAPSHOT_VERSION;
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly bindingId: string;
  readonly environment: TradingEnvironment;
  readonly provider: typeof METAAPI_RECONCILIATION_PROVIDER;
  readonly observedAt: string;
  readonly complete: boolean;
  readonly unavailable: boolean;
  readonly brokerCallSkipped: boolean;
  readonly invalid: boolean;
  readonly channels: BrokerChannels;
  readonly source: "injected-reader" | "not-called";
  readonly orders: readonly BrokerOrderObservation[];
  readonly deals: readonly BrokerDealObservation[];
  readonly positions: readonly BrokerPositionObservation[];
  readonly account: BrokerAccountObservation;
}

export interface BrokerSnapshotDraft {
  readonly bindingId: string;
  readonly environment: TradingEnvironment;
  readonly observedAt: string;
  readonly brokerCallSkipped: boolean;
  readonly invalid?: boolean;
  readonly channels: BrokerChannels;
  readonly source: "injected-reader" | "not-called";
  readonly orders: readonly BrokerOrderObservation[];
  readonly deals: readonly BrokerDealObservation[];
  readonly positions: readonly BrokerPositionObservation[];
  readonly account: BrokerAccountObservation;
}

/** Same canonical broker facts and the same caller-supplied observedAt produce
 * the same snapshot id. The id is not a clock read and not a random value. */
export function buildBrokerSnapshot(draft: BrokerSnapshotDraft): BrokerAccountSnapshot {
  const invalid = draft.invalid === true || hasDuplicateIds(draft);
  const channels: BrokerChannels = invalid
    ? { orders: "unavailable", deals: "unavailable", positions: "unavailable", account: "unavailable" }
    : draft.channels;
  const orders = channels.orders === "read" ? sortBy(draft.orders, (order) => order.orderId) : [];
  const deals = channels.deals === "read" ? sortBy(draft.deals, (deal) => deal.dealId) : [];
  const positions = channels.positions === "read" ? sortBy(draft.positions, (position) => position.positionId) : [];
  const account = channels.account === "read" ? draft.account : emptyAccount();
  const unavailable = draft.brokerCallSkipped || allUnavailable(channels);
  const complete = !draft.brokerCallSkipped && !invalid && allRead(channels);
  const body = {
    schemaVersion: BROKER_SNAPSHOT_VERSION,
    bindingId: draft.bindingId,
    environment: draft.environment,
    provider: METAAPI_RECONCILIATION_PROVIDER,
    observedAt: draft.observedAt,
    complete,
    unavailable,
    brokerCallSkipped: draft.brokerCallSkipped,
    invalid,
    channels,
    source: draft.source,
    orders,
    deals,
    positions,
    account,
  };
  const fingerprint = contentHash(body);
  return seal({
    ...body,
    fingerprint,
    snapshotId: `brk.${fingerprint.slice(0, 40)}`,
  });
}

export function emptyAccount(): BrokerAccountObservation {
  return { balance: null, equity: null, margin: null, currency: null };
}

function allRead(channels: BrokerChannels): boolean {
  return channels.orders === "read"
    && channels.deals === "read"
    && channels.positions === "read"
    && channels.account === "read";
}

function allUnavailable(channels: BrokerChannels): boolean {
  return channels.orders === "unavailable"
    && channels.deals === "unavailable"
    && channels.positions === "unavailable"
    && channels.account === "unavailable";
}

function hasDuplicateIds(draft: BrokerSnapshotDraft): boolean {
  return duplicates(draft.orders.map((order) => order.orderId))
    || duplicates(draft.deals.map((deal) => deal.dealId))
    || duplicates(draft.positions.map((position) => position.positionId));
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sortBy<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  return [...values].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}
