import type { DatabaseSync } from "node:sqlite";

import type { Decision } from "../../../shared/trading/decision.ts";
import { parseDecision } from "../../../shared/trading/decision.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields } from "../../../shared/trading/ids.ts";
import type { GateDecision } from "../gate/result.ts";
import type { PolicyDecision } from "../policy/result.ts";
import { canonicalJson } from "../replay/hash.ts";
import type { RiskDecision } from "../risk/result.ts";

/** Sealed reasoning bodies. The occurrence cites their existing ids. */
export interface ArtifactRepository {
  writeDecision(decision: Decision): void;
  writeRisk(risk: RiskDecision): void;
  writePolicy(policy: PolicyDecision): void;
  writeGate(gate: GateDecision): void;
  readDecision(id: string): Decision | "missing" | "malformed";
  readRisk(id: string): { id: string; state: string; reasons: readonly string[] } | "missing" | "malformed";
  readPolicy(id: string): { id: string; state: string; progression: string; reasons: readonly string[] } | "missing" | "malformed";
  readGate(id: string): { id: string; state: string; reasons: readonly string[] } | "missing" | "malformed";
}

export function createArtifactRepository(db: DatabaseSync, environment: TradingEnvironment): ArtifactRepository {
  return {
    writeDecision(decision) {
      const parsed = parseDecision(decision);
      if (parsed.environment !== environment) reject("Decision");
      writeRow(db, "trading_decisions", "decision_id", parsed.id, parsed.agentRunId, environment, parsed);
    },
    writeRisk(risk) {
      assertNoSecretFields(risk, "risk decision");
      if (risk.agentRunId.length === 0 || typeof risk.id !== "string") reject("Risk decision");
      writeRow(db, "trading_risk_decisions", "risk_decision_id", risk.id, risk.agentRunId, environment, risk);
    },
    writePolicy(policy) {
      assertNoSecretFields(policy, "policy decision");
      if (typeof policy.id !== "string") reject("Policy decision");
      writeRow(db, "trading_policy_decisions", "policy_decision_id", policy.id, policy.agentRunId, environment, policy);
    },
    writeGate(gate) {
      assertNoSecretFields(gate, "gate decision");
      if (gate.environment !== null && gate.environment !== environment) reject("Gate decision");
      writeRow(db, "trading_gate_decisions", "gate_decision_id", gate.id, gate.agentRunId, environment, gate);
    },
    readDecision(id) {
      const payload = readPayload(db, "trading_decisions", "decision_id", id);
      if (payload === "missing") return "missing";
      try {
        return parseDecision(payload);
      } catch {
        return "malformed";
      }
    },
    readRisk(id) {
      return readSummary(db, "trading_risk_decisions", "risk_decision_id", id, false);
    },
    readPolicy(id) {
      return readSummary(db, "trading_policy_decisions", "policy_decision_id", id, true);
    },
    readGate(id) {
      return readSummary(db, "trading_gate_decisions", "gate_decision_id", id, false);
    },
  };
}

/** Inserts one sealed body. A second body with the same id must match. */
export function writeSealedRow(
  db: DatabaseSync,
  table: "trading_decisions" | "trading_risk_decisions" | "trading_policy_decisions" | "trading_gate_decisions",
  idColumn: "decision_id" | "risk_decision_id" | "policy_decision_id" | "gate_decision_id",
  id: string,
  agentRunId: string,
  environment: TradingEnvironment,
  payload: unknown,
): void {
  writeRow(db, table, idColumn, id, agentRunId, environment, payload);
}

function writeRow(
  db: DatabaseSync,
  table: string,
  idColumn: string,
  id: string,
  agentRunId: string,
  environment: TradingEnvironment,
  payload: unknown,
): void {
  assertNoSecretFields(payload, "trading artifact");
  const json = canonicalJson(payload);
  const existing = db.prepare(`SELECT payload_json FROM ${table} WHERE ${idColumn} = ?`).get(id) as { payload_json: string } | undefined;
  if (existing !== undefined) {
    if (existing.payload_json !== json) {
      throw new TradingDomainError("immutable_revision", "Trading artifact already differs. Failing closed.");
    }
    return;
  }
  db.prepare(`
    INSERT INTO ${table} (${idColumn}, agent_run_id, environment, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(id, agentRunId, environment, json);
}

function readPayload(db: DatabaseSync, table: string, idColumn: string, id: string): unknown | "missing" {
  const row = db.prepare(`SELECT payload_json FROM ${table} WHERE ${idColumn} = ?`).get(id) as { payload_json: string } | undefined;
  if (row === undefined) return "missing";
  try {
    return JSON.parse(row.payload_json) as unknown;
  } catch {
    return "malformed";
  }
}

function readSummary(
  db: DatabaseSync,
  table: string,
  idColumn: string,
  id: string,
  withProgression: boolean,
): { id: string; state: string; progression: string; reasons: readonly string[] } | "missing" | "malformed" {
  const payload = readPayload(db, table, idColumn, id);
  if (payload === "missing" || payload === "malformed") return payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "malformed";
  const record = payload as { id?: unknown; state?: unknown; progression?: unknown; reasons?: unknown };
  if (record.id !== id || typeof record.state !== "string" || !Array.isArray(record.reasons) || record.reasons.some((item) => typeof item !== "string")) {
    return "malformed";
  }
  return {
    id,
    state: record.state,
    progression: withProgression && typeof record.progression === "string" ? record.progression : "",
    reasons: record.reasons as string[],
  };
}

function reject(label: string): never {
  throw new TradingDomainError("trading_store_rejected", `${label} was rejected. Failing closed.`);
}
