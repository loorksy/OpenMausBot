---
name: xauusd-production
description: Continues the OpenMausBot XAUUSD production implementation on the existing runtime. Use when extending trading, the desk, OANDA, MetaApi, reviews, or VPS deployment without starting a second agent or execution path.
---

You continue the OpenMausBot XAUUSD implementation that already exists on
`cursor/xauusd-foundation-b48b` and pull request #1. You do not start over
and you do not redesign the architecture.

OpenMausBot is the only agent runtime. There is no second trading agent,
scheduler, conversation, state machine, or execution engine. The only
broker path is `submitEligibleExecution` → `submitAuthorizedExecution` →
`provider.submit`. `provider.submit` is not a model tool.

The instrument is XAUUSD. Decision directions stay LONG, SHORT, NO_TRADE,
WAIT, MANAGE_EXISTING_POSITION, and EXIT_EXISTING_POSITION. LONG and SHORT
are the buy and sell directions. Do not add a probability field.

Market provenance is LIVE, STALE, SIMULATOR, UNAVAILABLE, or REPLAY. Only
LIVE data can authorize live execution. The stored kill switch is
authoritative. A missing switch fails closed. The fire-time gate rereads
it immediately before submission. An ambiguous broker response is not
retried. An accepted order is not an open position.

Phase C already attaches the trading room to the native thread. Preserve
`threadId`, `runtimeThreadId`, `providerTurnId`, `runtimeTurnId`,
`occurrenceId`, and `agentRunId`. A normal chat turn does not create a
trading occurrence. The room is a `GET /api/trading/desk` snapshot.
`tradingCursor` stays null. Chat text does not manufacture presence.

Before editing, inspect the branch, the store schema, and the tests.
Finish incomplete work in place. Do not reset the tree and do not drop
database history. New tables are forward migrations.

Reviews copy stored facts, interpretations, and cited learnings. They do
not invent explanations and they do not change risk, policy, approval, the
kill switch, autonomy, or the instrument.

OANDA and MetaApi live checks are pending unless real credentials and a
real connection were used in this session. Say so. Do not fake them.
Live trading stays locked until that verification exists.

Verify server changes with the isolated fixture in
`docs/verification/README.md` when the change is a server or conversation
flow that fixture can prove. Do not point tests at a user's live app.
Node must be >= 24 before claiming a browser or production runtime check.
