# XAUUSD market data

Phase 2 is the market-data boundary for the literal instrument `XAUUSD`.
It does not place orders, size risk, evaluate policy, or draw a desk.

The OpenMausBot harness is still the only agent runtime. This module does
not open the trading store and does not schedule reads. An authenticated
desk request may read the installed provider once.

## Boundary

`XauUsdMarketDataProvider` exposes `getXauUsdQuote()` and
`getXauUsdCandles(timeframe, range)`. There is no symbol argument.

`readXauUsdQuote` and `readXauUsdCandles` validate the provider body before
any snapshot is sealed. `createXauUsdMarketSnapshot` copies the validated
quote and bars into a Phase 1 `MarketSnapshot` and freezes it.
`buildXauUsdMarketContext` points at that snapshot. It does not add analysis.

`createDeterministicXauUsdProvider` is an in-memory fixture for tests. It is
not installed as a live feed.

The production feed is `createOandaXauUsdMarketDataProvider`. It implements
the same interface and calls the official OANDA v20 REST API:

- `GET /v3/accounts/{accountID}/pricing`
- `GET /v3/accounts/{accountID}/instruments/XAU_USD/candles`

It is installed only by `installConfiguredOandaProvider` when
`OMB_OANDA_API_TOKEN`, `OMB_OANDA_ACCOUNT_ID`, and `OMB_OANDA_ENVIRONMENT`
are all present and valid, and `OMB_XAUUSD_ENVIRONMENT` names the same
slot. `OMB_OANDA_ENVIRONMENT` is `practice` or `live`. Practice is accepted
only with `OMB_XAUUSD_ENVIRONMENT=PAPER` and
`https://api-fxpractice.oanda.com`. Live is accepted only with
`OMB_XAUUSD_ENVIRONMENT=LIVE` and `https://api-fxtrade.oanda.com`. A missing
trading environment, or any other pairing, leaves the provider uninstalled.
The host is not an environment variable. There is no demo alias and no
fallback from one environment to the other. A partial configuration leaves
the provider slot empty. The token stays inside the provider. It is removed
from `process.env` after a successful or attempted install so later process
snapshots do not inherit it.

The canonical symbol is `XAUUSD`. The only OANDA instrument requested is
`XAU_USD`. Any other instrument is unavailable. Quotes use top-of-book bid
and ask and require OANDA status `tradeable`. Candles request `price=M` and
read only the midpoint object. `D1` is OANDA granularity `D`. Incomplete
candles (`complete` not `true`) are excluded. A missing `complete` flag
rejects the payload. One candle read follows OANDA pages of at most 5000
bars. After the first page, `includeFirst` is false so the cursor bar is not
repeated. Four full pages that still end before the requested `to` fail the
read closed instead of returning a shorter series. The adapter does not place orders and does not read
MetaApi.

## Timeframes

Canonical frames are `M1`, `M5`, `M15`, `M30`, `H1`, `H4`, and `D1`.

A closed alias such as `15m` becomes `M15` and the original token is recorded
on `normalizations`. Any other token is rejected. One timeframe is never
replaced with another.

A bar is knowable only after its fixed length has elapsed: 60 seconds for
`M1`, through 24 hours for `D1`. A bar whose close is after the caller clock
is rejected. The close is not trimmed out of an otherwise accepted series.

## Provenance and freshness

Provenance is `LIVE`, `STALE`, `SIMULATOR`, `UNAVAILABLE`, or `REPLAY`.
`REPLAY` is historical market time. It is valid only in `SIMULATOR`, and a
stale replay payload stays `REPLAY`. It is not relabeled `LIVE`, `STALE`, or
`SIMULATOR`.

A failed read from a live provider is `UNAVAILABLE`, or `STALE` when the
failure kind is `stale_response`. It is never rewritten to `SIMULATOR` or
`REPLAY`.
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

Broker adapters, execution, simulator fills, paper trading, live order
routing, risk, policy, order intents, backtesting, and a production trading
database. Historical replay of local XAUUSD
fixtures is `docs/trading/replay.md`. A Phase 2 read still rejects a candle
series that contains a future bar. Replay does not trim that series after
the fact; the replay provider omits a bar until its close time.
