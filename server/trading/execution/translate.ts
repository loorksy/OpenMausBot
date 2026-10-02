const ACCEPT_CODES = new Set(["TRADE_RETCODE_DONE", "TRADE_RETCODE_PLACED"]);
const UNKNOWN_CODES = new Set(["TRADE_RETCODE_TIMEOUT", "TRADE_RETCODE_DONE_PARTIAL"]);
const CODE = /^TRADE_RETCODE_[A-Z0-9_]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface TranslatedBrokerResult {
  readonly kind: "accepted" | "rejected" | "filled" | "unknown";
  readonly brokerRequestId: string | null;
  readonly brokerCode: string | null;
  readonly fillPrice: number | null;
  readonly fillVolume: number | null;
  readonly brokerFillId: string | null;
}

/** Maps a MetaApi trade response. TRADE_RETCODE_DONE is an acknowledgement.
 * A fill is recorded only when the response carries an explicit filled order,
 * deal id, price, and the authorized volume. */
export function translateMetaApiTradeResponse(
  body: unknown,
  authorizedVolume: number,
): TranslatedBrokerResult {
  const unknown = empty("unknown");
  if (body === null || typeof body !== "object" || Array.isArray(body)) return unknown;
  const record = body as Record<string, unknown>;
  const code = typeof record.stringCode === "string" && CODE.test(record.stringCode) ? record.stringCode : null;
  const orderId = readId(record.orderId);
  if (record.orderState === "ORDER_STATE_FILLED") {
    const fillPrice = typeof record.fillPrice === "number" && Number.isFinite(record.fillPrice) ? record.fillPrice : null;
    const fillVolume = typeof record.fillVolume === "number" && Number.isFinite(record.fillVolume) ? record.fillVolume : null;
    const dealId = readId(record.dealId);
    if (typeof record.volume === "number" && record.volume !== authorizedVolume) return unknown;
    if (
      code !== null
      && ACCEPT_CODES.has(code)
      && orderId !== null
      && dealId !== null
      && fillPrice !== null
      && fillPrice > 0
      && fillVolume === authorizedVolume
    ) {
      return {
        kind: "filled",
        brokerRequestId: orderId,
        brokerCode: code,
        fillPrice,
        fillVolume,
        brokerFillId: dealId,
      };
    }
    return unknown;
  }
  if (code === null) return unknown;
  if (UNKNOWN_CODES.has(code)) return { ...unknown, brokerRequestId: orderId, brokerCode: code };
  if (typeof record.volume === "number" && record.volume !== authorizedVolume) {
    return { ...unknown, brokerRequestId: orderId, brokerCode: code };
  }
  if (ACCEPT_CODES.has(code)) {
    if (orderId === null) return unknown;
    return {
      kind: "accepted",
      brokerRequestId: orderId,
      brokerCode: code,
      fillPrice: null,
      fillVolume: null,
      brokerFillId: null,
    };
  }
  return {
    kind: "rejected",
    brokerRequestId: orderId,
    brokerCode: code,
    fillPrice: null,
    fillVolume: null,
    brokerFillId: null,
  };
}

function readId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && ID.test(value)) return value;
  return null;
}

function empty(kind: "unknown"): TranslatedBrokerResult {
  return {
    kind,
    brokerRequestId: null,
    brokerCode: null,
    fillPrice: null,
    fillVolume: null,
    brokerFillId: null,
  };
}
