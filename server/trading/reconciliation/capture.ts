import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import { assertNoSecretFields, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { MetaApiAccountBinding } from "../execution/binding.ts";
import { parseMetaApiAccountBinding } from "../execution/binding.ts";
import {
  buildBrokerSnapshot,
  emptyAccount,
  type BrokerAccountObservation,
  type BrokerAccountSnapshot,
  type BrokerChannel,
  type BrokerChannels,
  type BrokerDealObservation,
  type BrokerOrderObservation,
  type BrokerPositionObservation,
} from "./snapshot.ts";

/** Read-only broker observation. The reader is injected. This module does not
 * submit, modify, close, or change stop-loss or take-profit. */
export interface BrokerRead<T> {
  readonly kind: "ok" | "unavailable";
  readonly value?: T;
}

export interface MetaApiReconciliationReader {
  getOrders(): Promise<BrokerRead<unknown>>;
  getDeals(): Promise<BrokerRead<unknown>>;
  getPositions(): Promise<BrokerRead<unknown>>;
  getAccountState(): Promise<BrokerRead<unknown>>;
}

export interface MetaApiReconciliationAdapter {
  readonly providerId: "metaapi-cloud";
  readonly bindingId: string;
  readonly readOnly: true;
  capture(input: {
    readonly environment: TradingEnvironment;
    readonly provenance: ProvenanceStatus;
    readonly observedAt: string;
  }): Promise<BrokerAccountSnapshot>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SYMBOL = /^[A-Z0-9._:-]{1,32}$/;
const SAFE_STATE = /^[A-Z0-9_]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Credentials stay in the closure. They are not fields, snapshot data, or errors. */
export function createMetaApiReconciliationAdapter(input: {
  readonly binding: unknown;
  readonly token: string;
  readonly accountId: string;
  readonly reader: MetaApiReconciliationReader;
}): MetaApiReconciliationAdapter {
  const binding = parseMetaApiAccountBinding(input.binding);
  const token = typeof input.token === "string" ? input.token : "";
  const accountId = typeof input.accountId === "string" ? input.accountId : "";
  const configured = binding !== null && token.length > 0 && accountId.length > 0;
  return {
    providerId: "metaapi-cloud",
    bindingId: binding?.bindingId ?? "unbound",
    readOnly: true,
    capture: (captureInput) => captureBrokerSnapshot({
      environment: captureInput.environment,
      provenance: captureInput.provenance,
      binding,
      configured,
      reader: input.reader,
      observedAt: captureInput.observedAt,
    }),
  };
}

export async function captureBrokerSnapshot(input: {
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly binding: MetaApiAccountBinding | null;
  readonly configured: boolean;
  readonly reader: MetaApiReconciliationReader;
  readonly observedAt: string;
}): Promise<BrokerAccountSnapshot> {
  if (!utcTimestampSchema.safeParse(input.observedAt).success) {
    throw new TradingDomainError("trading_store_rejected", "Broker observation timestamp was rejected. Failing closed.");
  }
  const bindingId = input.binding?.bindingId ?? "";
  const skipped = input.environment === "SIMULATOR"
    || input.provenance !== "LIVE"
    || input.binding === null
    || !input.configured
    || input.binding.environment !== input.environment;
  if (skipped) {
    return buildBrokerSnapshot({
      bindingId,
      environment: input.environment,
      observedAt: input.observedAt,
      brokerCallSkipped: true,
      channels: unread(),
      source: "not-called",
      orders: [],
      deals: [],
      positions: [],
      account: emptyAccount(),
    });
  }
  const orders = await readChannel(input.reader.getOrders.bind(input.reader), normalizeOrders);
  const deals = await readChannel(input.reader.getDeals.bind(input.reader), normalizeDeals);
  const positions = await readChannel(input.reader.getPositions.bind(input.reader), normalizePositions);
  const account = await readChannel(input.reader.getAccountState.bind(input.reader), normalizeAccount);
  return buildBrokerSnapshot({
    bindingId,
    environment: input.environment,
    observedAt: input.observedAt,
    brokerCallSkipped: false,
    channels: {
      orders: orders.channel,
      deals: deals.channel,
      positions: positions.channel,
      account: account.channel,
    },
    source: "injected-reader",
    orders: orders.value ?? [],
    deals: deals.value ?? [],
    positions: positions.value ?? [],
    account: account.value ?? emptyAccount(),
  });
}

async function readChannel<T>(
  read: () => Promise<BrokerRead<unknown>>,
  normalize: (value: unknown) => T | null,
): Promise<{ channel: BrokerChannel; value: T | null }> {
  try {
    const result = await read();
    if (result.kind !== "ok") return { channel: "unavailable", value: null };
    const normalized = normalize(result.value);
    if (normalized === null) return { channel: "unavailable", value: null };
    return { channel: "read", value: normalized };
  } catch {
    return { channel: "unavailable", value: null };
  }
}

function unread(): BrokerChannels {
  return { orders: "unavailable", deals: "unavailable", positions: "unavailable", account: "unavailable" };
}

function normalizeOrders(value: unknown): BrokerOrderObservation[] | null {
  if (!clean(value)) return null;
  if (!Array.isArray(value)) return null;
  const orders: BrokerOrderObservation[] = [];
  for (const item of value) {
    if (!plain(item)) return null;
    const orderId = text(item.orderId, SAFE_ID);
    const symbol = text(item.symbol, SAFE_SYMBOL);
    const volume = number(item.volume);
    if (orderId === null || symbol === null || volume === null || volume < 0) return null;
    const clientId = item.clientId === undefined || item.clientId === null ? null : text(item.clientId, SAFE_ID);
    if (item.clientId !== undefined && item.clientId !== null && clientId === null) return null;
    const direction = directionOf(item.direction);
    if (direction === "invalid") return null;
    const state = item.state === undefined || item.state === null ? null : text(item.state, SAFE_STATE);
    if (item.state !== undefined && item.state !== null && state === null) return null;
    const stopLoss = optionalNumber(item.stopLoss);
    const takeProfit = optionalNumber(item.takeProfit);
    if (stopLoss === "invalid" || takeProfit === "invalid") return null;
    orders.push({ orderId, clientId, symbol, volume, direction, state, stopLoss, takeProfit });
  }
  return orders;
}

function normalizeDeals(value: unknown): BrokerDealObservation[] | null {
  if (!clean(value)) return null;
  if (!Array.isArray(value)) return null;
  const deals: BrokerDealObservation[] = [];
  for (const item of value) {
    if (!plain(item)) return null;
    const dealId = text(item.dealId, SAFE_ID);
    const symbol = text(item.symbol, SAFE_SYMBOL);
    const volume = number(item.volume);
    if (dealId === null || symbol === null || volume === null || volume < 0) return null;
    const orderId = optionalId(item.orderId);
    const clientId = optionalId(item.clientId);
    const positionId = optionalId(item.positionId);
    if (orderId === "invalid" || clientId === "invalid" || positionId === "invalid") return null;
    const price = optionalNumber(item.price);
    if (price === "invalid") return null;
    deals.push({
      dealId,
      orderId,
      clientId,
      positionId,
      symbol,
      volume,
      price,
    });
  }
  return deals;
}

function normalizePositions(value: unknown): BrokerPositionObservation[] | null {
  if (!clean(value)) return null;
  if (!Array.isArray(value)) return null;
  const positions: BrokerPositionObservation[] = [];
  for (const item of value) {
    if (!plain(item)) return null;
    const positionId = text(item.positionId, SAFE_ID);
    const symbol = text(item.symbol, SAFE_SYMBOL);
    const volume = number(item.volume);
    if (positionId === null || symbol === null || volume === null || volume < 0) return null;
    const direction = directionOf(item.direction);
    if (direction === "invalid") return null;
    positions.push({ positionId, symbol, volume, direction });
  }
  return positions;
}

function normalizeAccount(value: unknown): BrokerAccountObservation | null {
  if (!clean(value) || !plain(value)) return null;
  const balance = optionalNumber(value.balance);
  const equity = optionalNumber(value.equity);
  const margin = optionalNumber(value.margin);
  if (balance === "invalid" || equity === "invalid" || margin === "invalid") return null;
  const currency = value.currency === undefined || value.currency === null ? null : text(value.currency, CURRENCY);
  if (value.currency !== undefined && value.currency !== null && currency === null) return null;
  return { balance, equity, margin, currency };
}

function clean(value: unknown): boolean {
  try {
    assertNoSecretFields(value, "broker observation");
    return true;
  } catch {
    return false;
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNumber(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  const parsed = number(value);
  return parsed === null ? "invalid" : parsed;
}

function optionalId(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  const parsed = text(value, SAFE_ID);
  return parsed === null ? "invalid" : parsed;
}

function directionOf(value: unknown): "LONG" | "SHORT" | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (value === "LONG" || value === "SHORT") return value;
  return "invalid";
}
