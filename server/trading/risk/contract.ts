/** XAUUSD contract used by the risk engine. This is not a broker profile
 * and it does not encode leverage or margin. */

export const XAUUSD_CONTRACT_VERSION = "xauusd-contract-1" as const;

export const XAUUSD_OUNCES_PER_LOT = 100;

export const XAUUSD_QUANTITY_UNIT = "lot" as const;

export const XAUUSD_PRICE_UNIT = "USD per troy ounce" as const;

export interface XauUsdContractSpec {
  readonly version: typeof XAUUSD_CONTRACT_VERSION;
  readonly symbol: "XAUUSD";
  readonly ouncesPerLot: typeof XAUUSD_OUNCES_PER_LOT;
  readonly quantityUnit: typeof XAUUSD_QUANTITY_UNIT;
  readonly priceUnit: typeof XAUUSD_PRICE_UNIT;
}

export const XAUUSD_CONTRACT: XauUsdContractSpec = {
  version: XAUUSD_CONTRACT_VERSION,
  symbol: "XAUUSD",
  ouncesPerLot: XAUUSD_OUNCES_PER_LOT,
  quantityUnit: XAUUSD_QUANTITY_UNIT,
  priceUnit: XAUUSD_PRICE_UNIT,
};
