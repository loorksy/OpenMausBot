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
  unrecognized reconciliation value throws. `DEGRADED` is a known state.
  Phase 6 policy does not take a reconciliation input, so it does not add a
  `DEGRADED` rule.
- A missing or malformed kill-switch state fails closed. An engaged switch
  blocks. Policy reads that state. There is still no kill-switch runtime.
- Autonomy levels `0` through `5` are named `OBSERVE` through
  `AUTONOMOUS_MONITORING`. No level allows a direct broker submit. This is
  separate from provider `approvalMode`.

## What is not implemented

Market-data reads use `docs/trading/market-data.md`. The XAUUSD tool
catalog for the existing OpenMausBot tool loop is `docs/trading/agent-tools.md`.
Deterministic historical replay is `docs/trading/replay.md`. Evaluation of
that same agent against replay is `docs/trading/evaluation.md`. The tool catalog
can propose a decision or a non-executable order intent. Deterministic risk
and policy are `docs/trading/risk.md` and `docs/trading/policy.md`. The
approval engine and fire-time gate are `docs/trading/approval.md` and
`docs/trading/execution-gate.md`. `evaluateFireTimeGate` can return
`ELIGIBLE_FOR_EXECUTION`. That state is authorization only. The MetaApi
Cloud execution boundary is `docs/trading/execution.md`. It submits only
that authorization, and only through an injected transport. The optional
XAUUSD market feed is the OANDA v20 REST provider in
`docs/trading/market-data.md`. It is installed only when its configuration
is complete, and it does not place orders. A local MetaTrader 5 terminal,
simulator fills, kill-switch enforcement, P&L, strategy scoring, and
production configuration are not implemented. The desk chart is KLineChart Pro. It draws the canonical
XAUUSD market contract and is not a market-data provider. Reconciliation against a
captured broker snapshot is `docs/trading/reconciliation.md`.

`foundationControl` in `server/trading/control/boundaries.ts` still throws
`TradingDomainError` with `failClosed: true` when called with no authoritative
inputs. The risk, policy, approval, and fire-time functions are separate
and require those inputs. `submitAuthorizedExecution` is the execution
boundary and requires the same kind of explicit inputs. `foundationControl.runExecutionGate`,
`foundationControl.reconcile`, kill-switch runtime, and `foundationControl.submitToBroker`
still throw. `reconcileExecution` is the pure comparison and does not replace
that stub.
`applyTradingMigrations()` and `openTradingStore()` with no arguments throw
the same way, so a call cannot create a hidden default database.
`TRADING_STORE_SCHEMA_VERSION` is `1`. An explicit path and environment open
a `node:sqlite` file and migrate it. Version `0` means the file had no
trading schema; the migration creates tables and does not delete rows.

No broker credentials are read or stored.
