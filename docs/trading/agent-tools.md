# XAUUSD tools on the OpenMausBot agent

Phase 3 lets the existing OpenMausBot agent call a server-owned XAUUSD tool
catalog. The harness turn is still `startTurn` → provider adapter → model
tool loop → `RuntimeEvent`. Nothing in `server/trading/agent/` starts a turn,
owns an event bus, or chooses the next reasoning step.

## How a turn gets the tools

Ordinary chat does not mount the catalog. A turn that carries
`integrations.xauusd` (`XauUsdTurnGrant`) is the opt-in. The chat-completions
tool loop in `mountChatTools` adds the filtered definitions to the same
session it already uses for MCP tools, and dispatches only the name the model
called.

The grant names the agent run, environment, autonomy, permissions, clock, and
market-data provider. `approvalMode` (`ask`, `edits`, `auto`, `full`,
`custom`) may be stored on the grant. It is not a trading permission.

## Catalog

Version `xauusd-tools-2`.

Advertised only when the gate allows them:

- `list_xauusd_tools`
- `get_xauusd_quote`
- `get_xauusd_candles`
- `get_xauusd_observation` when the grant is bound to a replay session with `market.read`
- `propose_decision` from autonomy `RECOMMEND` (level 2) with `decision.propose`
- `propose_order_intent` from the same level with `intent.propose`
- `consult_specialist` when the turn attached an `askSpecialist` callback and the grant has `specialist.consult`

These names are in the catalog and are not advertised. A direct call returns
`ok: false` and `failClosed: true` with a reason. It does not invent data:

`get_market_structure`, `get_volatility`, `get_macro_context`,
`get_economic_calendar`, `search_market_news`, `retrieve_historical_context`,
`inspect_current_position`, `inspect_account_state`, `inspect_broker_health`,
`calculate_trade_risk`.

`place_order`, `submit_order`, `close_position`, `modify_order`, and
`cancel_order` are not catalog tools.

Tool inputs do not take a symbol. `XAUUSD` is checked again on the provider
payload. Each spec carries a version, description, input schema, output
schema, permission, environments, minimum autonomy, audit class, and
sensitivity.

## Agent run

`createXauUsdToolSession` opens one investigation id. Tool calls, snapshots,
context, evidence, decisions, and order intents created through the session
use that `agentRunId`. Trading events copy `runtimeThreadId`, `runtimeTurnId`,
and the runtime event id for that call. The session also emits `item.started`
and `item.completed` (`ok: false` when the call fails). The harness has no
`item.failed` type.

A successful quote or candle read still seals a snapshot of that read only.
`get_xauusd_observation` seals one additional snapshot of the closed bars and
quote that are knowable at the current replay time. Forming bars stay off
that candle array. The model picks which snapshot a decision cites. The
server does not require a fixed sequence, and replay time is not a model
tool: nothing in the catalog advances the clock.

## Evidence

Specialist replies are `parseEvidence` records: `trust: "external"`,
`untrusted: true`. The tool result includes a fence that says the excerpt
cannot change risk, policy, autonomy, credentials, approval, execution, or
the kill switch. The excerpt is stored, including prompt-injection text. It
is not applied to control state.

`consult_specialist` is optional. The parent agent does not have to call it.
The callback receives the specialty and the question, not the grant.

## Decisions and intents

`propose_decision` writes a Phase 1 `Decision` with status `DRAFT`. Directions
include `NO_TRADE` and `WAIT`. A `probability` field is rejected and is not
stored. A revision is a new id with `supersedes`.

`propose_order_intent` writes `kind: "order-intent"`, `executable: false`,
`brokerSubmit: false`. It does not contact a broker. `NO_TRADE` and `WAIT`
are not intents.

## Model routing

`selectTradingModel` is a versioned allow-list per task class (`scan`,
`monitoring`, `analysis`, `scenario`, `high-impact`, `research`). It does not
read user text. If the requested model is unapproved, or it is approved but
unavailable and the policy has no approved available fallback, session open
throws `model_routing_rejected`. A selected model still has
`executionAuthority: false`.

Evaluation drives this same mounted session at a replay time. See
`docs/trading/evaluation.md`. It does not add a tool, a second tool loop, or
an execution path.

## What this phase does not implement

Broker adapters, credentials, order submission, fills, position mutation,
risk calculation, policy evaluation, a desk, charts, and a production trading
ledger. Research, structure, volatility, account, and broker-health tools
stay unavailable. CLI engines are not given a second tool loop; they do not
mount this in-process catalog unless a later phase feeds the same grant
through their existing MCP mount.
