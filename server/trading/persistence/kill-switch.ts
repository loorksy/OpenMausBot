import type { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState, type KillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { canonicalJson } from "../replay/hash.ts";

/** One stored switch for an environment and agent run. Callers do not
 * authorize from a second in-memory copy. */
export interface KillSwitchRead {
  readonly status: "open" | "engaged" | "unknown";
  readonly reason: "missing" | "malformed" | "environment" | "agent" | null;
  readonly state: KillSwitchState | null;
}

export interface KillSwitchAuthority {
  read(environment: TradingEnvironment, agentRunId: string): KillSwitchRead;
}

export interface KillSwitchRepository {
  read(agentRunId: string): KillSwitchRead;
  write(state: KillSwitchState): void;
  authority(): KillSwitchAuthority;
}

const AUTHORITATIVE_KILL_SWITCH = Symbol("openmausbot.authoritative-kill-switch");

/** True only for a repository created by `createKillSwitchRepository`.
 * That factory is called from `openTradingStore`. A caller-built reader,
 * including one that reports open, does not pass. */
export function isAuthoritativeKillSwitchRepository(value: unknown): value is KillSwitchRepository {
  return value !== null
    && typeof value === "object"
    && (value as { [AUTHORITATIVE_KILL_SWITCH]?: unknown })[AUTHORITATIVE_KILL_SWITCH] === true;
}

const UNKNOWN = (reason: KillSwitchRead["reason"]): KillSwitchRead => ({ status: "unknown", reason, state: null });

export function createKillSwitchRepository(db: DatabaseSync, environment: TradingEnvironment): KillSwitchRepository {
  const repository: KillSwitchRepository = {
    read(agentRunId) {
      return readRow(db, environment, agentRunId);
    },
    write(state) {
      const parsed = parseKillSwitchState(state);
      if (parsed.environment !== environment) {
        throw new TradingDomainError("trading_store_rejected", "Kill switch environment does not match the store partition. Failing closed.");
      }
      db.prepare(`
        INSERT INTO kill_switch_state (environment, agent_run_id, payload_json)
        VALUES (?, ?, ?)
        ON CONFLICT (environment, agent_run_id) DO UPDATE SET payload_json = excluded.payload_json
      `).run(environment, parsed.agentRunId, canonicalJson(parsed));
    },
    authority() {
      return {
        read(requested, agentRunId) {
          if (requested !== environment) return UNKNOWN("environment");
          return readRow(db, environment, agentRunId);
        },
      };
    },
  };
  Object.defineProperty(repository, AUTHORITATIVE_KILL_SWITCH, { value: true });
  return repository;
}

function readRow(db: DatabaseSync, environment: TradingEnvironment, agentRunId: string): KillSwitchRead {
  if (typeof agentRunId !== "string" || agentRunId.length === 0) return UNKNOWN("agent");
  const row = db.prepare(
    "SELECT payload_json FROM kill_switch_state WHERE environment = ? AND agent_run_id = ?",
  ).get(environment, agentRunId) as { payload_json: string } | undefined;
  if (row === undefined) return UNKNOWN("missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    return UNKNOWN("malformed");
  }
  return classify(parsed, environment, agentRunId);
}

function classify(value: unknown, environment: TradingEnvironment, agentRunId: string): KillSwitchRead {
  try {
    const state = parseKillSwitchState(value);
    if (state.environment !== environment) return UNKNOWN("environment");
    if (state.agentRunId !== agentRunId) return UNKNOWN("agent");
    return state.engaged
      ? { status: "engaged", reason: null, state }
      : { status: "open", reason: null, state };
  } catch {
    return UNKNOWN("malformed");
  }
}
