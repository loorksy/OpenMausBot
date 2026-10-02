# XAUUSD production runtime

OpenMausBot stays one process. The trading store, the native routine turn,
and the MetaApi boundary run inside that process. Do not add a trading
worker, a second scheduler, or a second Node service. `RoutineManager` is
the only scheduler.

The existing install is the Ubuntu path in `docs/deploy-vps.md`: Node >= 24,
one systemd unit, and the Caddyfile in `deploy/Caddyfile` when TLS is
terminated on the host. This repository does not use PM2 for OpenMausBot.
Do not put a domain name or a secret in the unit file.

## Environment

Market data is installed only when all of these are set and paired:

- `OMB_OANDA_API_TOKEN`
- `OMB_OANDA_ACCOUNT_ID`
- `OMB_OANDA_ENVIRONMENT` (`practice` or `live`)
- `OMB_XAUUSD_ENVIRONMENT` (`PAPER` with practice, `LIVE` with live)
- `OMB_XAUUSD_STORE_PATH`

A missing value leaves the provider uninstalled. There is no silent
fallback from live prices to the simulator.

MetaApi credentials are accepted only by `createMetaApiExecutionAdapter`.
They are not model tools and they are not written into trading events.
This tree does not contain a live token. Live broker calls stay unwired
until an operator passes a real token into that adapter through the
existing `submitEligibleExecution` path.

## Migrations and backups

`openTradingStore` applies forward `CREATE TABLE IF NOT EXISTS` statements
and raises `schema_meta.version`. It does not drop tables. The current
version is 8, which adds `trading_reviews`.

Back up the SQLite file at `OMB_XAUUSD_STORE_PATH` with the rest of the
OpenMausBot data directory, using the host procedure already documented for
the server. Copying that file while the process is stopped is a consistent
backup. A copy taken during writes needs the SQLite backup API on Node >= 24.

## What this document does not verify

No OANDA practice call, MetaApi paper call, VPS reboot, or HTTPS deployment
was performed from this repository state. Live trading stays fail-closed
until those checks are done on the real host.
