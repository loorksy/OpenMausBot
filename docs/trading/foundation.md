# XAUUSD trading foundation

Phase 1 defines the FOX/NANO XAUUSD contracts. OpenMausBot's harness
(`server/harness/`, `server/drivers/`, `shared/runtime-events.ts`) remains the
only agent runtime. Nothing here starts a turn, selects a model, or talks to
a broker.

Contracts live in `shared/trading/` so a later desk and the server share one
parser. `server/trading/` re-exports them and holds the fail-closed boundaries
that later phases replace. Those modules are not mounted on the HTTP server.

## What this phase accepts

- The only instrument is the literal `XAUUSD`. Any other value fails closed
  with `instrument_rejected`.
- `SIMULATOR`, `PAPER`, and `LIVE` are distinct environments. A call cannot
  move from one to another. Credential slots are `none`, `paper`, and `live`.
  Bindings keep `liveExecutionEnabled` and `brokerNetworkEnabled` false.
- `SIMULATOR` provenance cannot be used by `PAPER` or `LIVE`. `SIMULATOR`
  cannot be labeled `LIVE`. `REPLAY` provenance is historical market time and
  is valid only in `SIMULATOR`. It is not `LIVE` and not a live-feed fallback.
- Decisions may be `LONG`, `SHORT`, `NO_TRADE`, `WAIT`,
  `MANAGE_EXISTING_POSITION`, or `EXIT_EXISTING_POSITION`.
- Evidence is `trust: "external"` and `untrusted: true`.
- An order intent is `kind: "order-intent"` with `executable: false` and
  `brokerSubmit: false`. It has no credential fields and no submit method.
- Market snapshots, evidence, and decisions are frozen. A revision is a new
  id whose `supersedes` points at the previous id.
- Trading events use `source: "trading-domain"` and their own type union.
  They may store a harness event id. They are not `RuntimeEvent`s.
- Records and events require `agentRunId`.
- A version manifest names runtime, model provider, model, prompt, tool
  catalog, risk, policy, and feature/data versions. Replay also requires a
  dataset version.
- `DESYNCED` and `UNKNOWN` reconciliation block autonomous orders. Any other
  unrecognized reconciliation value throws. `DEGRADED` is a known state and
  does not by itself block; policy is not implemented yet.
- A missing or malformed kill-switch state fails closed. An engaged switch
  blocks. There is no kill-switch runtime.
- Autonomy levels `0` through `5` are named `OBSERVE` through
  `AUTONOMOUS_MONITORING`. No level allows a direct broker submit. This is
  separate from provider `approvalMode`.

## What is not implemented

Market-data reads use `docs/trading/market-data.md`. The XAUUSD tool
catalog for the existing OpenMausBot tool loop is `docs/trading/agent-tools.md`.
Deterministic historical replay is `docs/trading/replay.md`. Evaluation of
that same agent against replay is `docs/trading/evaluation.md`. The tool catalog
can propose a decision or a non-executable order intent. No external feed is
configured. Broker adapters, OANDA, MetaApi, MT5, simulator fills, paper
execution, live execution, risk calculations, policy evaluation, the
execution gate, kill-switch enforcement, reconciliation against a broker,
P&L, strategy scoring, the desk, TradingView, database migrations, and
production configuration are not implemented.

`foundationControl` in `server/trading/control/boundaries.ts` throws
`TradingDomainError` with `failClosed: true` for each of those engines.
`applyTradingMigrations` and `openTradingStore` throw the same way.
`TRADING_STORE_SCHEMA_VERSION` is `0`.

No broker credentials are read or stored.
