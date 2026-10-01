/** Phase 1 trading foundation. Not wired into the harness HTTP server.
 * Later phases plug engines into these contracts. They must not start a
 * second agent runtime. */

export * from "./domain/index.ts";
export { foundationControl } from "./control/boundaries.ts";
export {
  TRADING_STORE_SCHEMA_VERSION,
  applyTradingMigrations,
  openTradingStore,
  tradingPartitionKey,
} from "./persistence/store.ts";
