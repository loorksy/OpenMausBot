# XAUUSD market data

Phase 2 is the market-data boundary for the literal instrument `XAUUSD`.
It does not place orders, size risk, evaluate policy, or draw a desk.

The OpenMausBot harness is still the only agent runtime. This module is not
mounted on the HTTP server and does not open the trading store.

## Boundary

`XauUsdMarketDataProvider` exposes `getXauUsdQuote()` and
`getXauUsdCandles(timeframe, range)`. There is no symbol argument.

`readXauUsdQuote` and `readXauUsdCandles` validate the provider body before
any snapshot is sealed. `createXauUsdMarketSnapshot` copies the validated
quote and bars into a Phase 1 `MarketSnapshot` and freezes it.
`buildXauUsdMarketContext` points at that snapshot. It does not add analysis.

The only implementation in this phase is `createDeterministicXauUsdProvider`,
an in-memory fixture. No external market-data vendor is configured. OANDA,
MetaApi, and MT5 are not used.

## Timeframes

Canonical frames are `M1`, `M5`, `M15`, `M30`, `H1`, `H4`, and `D1`.

A closed alias such as `15m` becomes `M15` and the original token is recorded
on `normalizations`. Any other token is rejected. One timeframe is never
replaced with another.

A bar is knowable only after its fixed length has elapsed: 60 seconds for
`M1`, through 24 hours for `D1`. A bar whose close is after the caller clock
is rejected. The close is not trimmed out of an otherwise accepted series.

## Provenance and freshness

Provenance remains `LIVE`, `STALE`, `SIMULATOR`, or `UNAVAILABLE`.

A failed read from a live provider is `UNAVAILABLE`, or `STALE` when the
failure kind is `stale_response`. It is never rewritten to `SIMULATOR`.
A success body that claims `SIMULATOR` outside the `SIMULATOR` environment
is rejected.

`LIVE` data older than the caller-supplied `staleAfterMs` is labeled `STALE`.
The provider timestamp stays as the provider sent it. `receivedAt` and
`processedAt` are the caller clock, in UTC. `+00:00` may be stored as `Z`;
that note is recorded. Other invalid timestamps are rejected.

`staleAfterMs`, `futureSkewMs`, and `abnormalLatencyMs` are data-quality
limits passed in by the caller. They are not an execution threshold. The
later policy phase decides whether stale data may be traded.

Abnormal processing latency is recorded and does not by itself invent a new
price. A provider timestamp further ahead than `futureSkewMs` is rejected.

## Failures

Timeout, malformed bodies, authentication failure, rate limit, network
failure, empty bodies, partial quotes, future timestamps, and conflicting or
duplicate bars produce a failed result and one trading event. They do not
produce a quote or a snapshot. Provider messages are redacted before they
enter an event payload.

Events used here are `market.quote.updated`, `market.candles.updated`,
`market.stale`, `market.unavailable`, `market.invalid`,
`market.provider_error`, and `market.snapshot.created`. Each one is emitted
only after that operation runs.

## What this phase does not implement

Broker adapters, execution, simulator fills, paper trading, live trading,
risk, policy, order intents, replay, backtesting, a production trading
database, a desk, and any real market-data vendor.
