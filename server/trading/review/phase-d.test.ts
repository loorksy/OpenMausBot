import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseDecision } from "../../../shared/trading/decision.ts";
import { createXauUsdToolSession } from "../agent/session.ts";
import { loadTradingRoom } from "../desk/load.ts";
import { createDeterministicXauUsdProvider } from "../infrastructure/market_data/provider.ts";
import {
  bindXauUsdProviderTurn,
  dispatchXauUsdRoutineTurn,
  sealNativeToolTurn,
} from "../occurrence/runtime.ts";
import type { XauUsdToolSession } from "../agent/session.ts";
import { openTradingStore } from "../persistence/store.ts";
import { tradingMemoryRecord } from "../memory/record.ts";
import { recordPostTradeReview } from "./record.ts";

const AT = "2026-08-15T14:30:00.000Z";
const LATER = "2026-08-15T15:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-review-"));
  dirs.push(dir);
  return dir;
}

describe("post-trade review", () => {
  it("copies facts, interpretations, and cited learnings without inventing a probability or rewriting the kill switch", () => {
    const dir = tempDir();
    const path = join(dir, "trading.db");
    const store = openTradingStore({ path, environment: "PAPER" });
    const occurrence = store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: "run-1",
      threadId: "thread-1",
      environment: "PAPER",
      startedAt: AT,
    });
    const decision = parseDecision({
      schemaVersion: 1,
      id: "dec-1",
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      instrument: "XAUUSD",
      createdAt: AT,
      status: "DRAFT",
      thesis: "NO_TRADE because the stored snapshot had no setup.",
      contextId: "ctx-1",
      snapshotId: "snap-1",
      evidenceIds: [],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingInformation: [],
      direction: "NO_TRADE",
      targets: [],
      expiry: "2026-08-15T18:00:00.000Z",
      evidenceQuality: "insufficient",
      versionManifestId: "ver-1",
    });
    store.occurrences.attachAuthoritativeRecords({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      decisionId: decision.id,
      orderIntentId: null,
      riskDecisionId: null,
      policyDecisionId: null,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
      gateDecisionId: null,
      decision,
      risk: null,
      policy: null,
      gate: null,
    });
    store.memory.append(tradingMemoryRecord({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      kind: "FACT",
      revision: 1,
      supersedes: null,
      recordedAt: AT,
      body: "The quote was 4630/4633.",
    }));
    store.memory.append(tradingMemoryRecord({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      kind: "INTERPRETATION",
      revision: 1,
      supersedes: null,
      recordedAt: AT,
      body: "The stored thesis expected no entry.",
    }));
    const learning = store.memory.appendLearning({
      target: "explanation",
      fields: ["wording"],
      note: "Say that NO_TRADE is a decision.",
      recordedAt: AT,
    });
    store.killSwitches.write({
      schemaVersion: 1,
      environment: "PAPER",
      engaged: true,
      agentRunId: occurrence.agentRunId,
      updatedAt: AT,
      source: "operator",
    });
    const recorded = recordPostTradeReview(store, {
      occurrenceId: occurrence.occurrenceId,
      recordedAt: LATER,
      learningRevisionIds: [learning.revisionId ?? ""],
    });
    expect(recorded.recorded).toBe(true);
    if (!recorded.recorded) return;
    expect(recorded.inserted).toBe(true);
    expect(recorded.review.facts.decision.direction).toBe("NO_TRADE");
    expect(recorded.review.facts.decision.thesis).toBe(decision.thesis);
    expect(recorded.review.facts.validatedFacts.map((item) => item.body)).toEqual(["The quote was 4630/4633."]);
    expect(recorded.review.interpretations.map((item) => item.body)).toEqual(["The stored thesis expected no entry."]);
    expect(recorded.review.learnings.map((item) => item.target)).toEqual(["explanation"]);
    expect(JSON.stringify(recorded.review)).not.toContain("probability");
    expect(JSON.stringify(recorded.review)).not.toContain("killSwitch");
    expect(store.killSwitches.read(occurrence.agentRunId).status).toBe("engaged");
    const again = recordPostTradeReview(store, {
      occurrenceId: occurrence.occurrenceId,
      recordedAt: LATER,
      learningRevisionIds: [learning.revisionId ?? ""],
    });
    expect(again).toMatchObject({ recorded: true, inserted: false, review: { reviewId: recorded.review.reviewId, revision: 1 } });
    store.close();
    const reopened = openTradingStore({ path, environment: "PAPER" });
    expect(reopened.reviews.readLatest(occurrence.occurrenceId)).toMatchObject({ reviewId: recorded.review.reviewId });
    expect(reopened.schemaVersion).toBe(8);
    reopened.close();
    const room = loadTradingRoom(
      { OMB_XAUUSD_STORE_PATH: path, OMB_XAUUSD_ENVIRONMENT: "PAPER" },
      { provenance: "LIVE", timeframe: "M15", candles: [] },
      LATER,
    );
    expect(room.review).toMatchObject({
      facts: { decision: { direction: "NO_TRADE", thesis: decision.thesis } },
      interpretations: [{ body: "The stored thesis expected no entry." }],
    });
    expect(room.learning).toMatchObject({ accepted: true, target: "explanation" });
    expect(room.killSwitch.state).toBe("engaged");
  });

  it("does not review an occurrence that has no decision and does not cite a missing learning", () => {
    const dir = tempDir();
    const store = openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
    const occurrence = store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: "run-2",
      threadId: "thread-1",
      environment: "PAPER",
      startedAt: AT,
    });
    expect(recordPostTradeReview(store, { occurrenceId: occurrence.occurrenceId, recordedAt: LATER })).toEqual({
      recorded: false,
      reason: "DECISION_UNAVAILABLE",
    });
    expect(store.reviews.readLatest(occurrence.occurrenceId)).toBe("missing");
    const decision = parseDecision({
      schemaVersion: 1,
      id: "dec-2",
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      instrument: "XAUUSD",
      createdAt: AT,
      status: "DRAFT",
      thesis: "WAIT.",
      contextId: "ctx-1",
      snapshotId: "snap-1",
      evidenceIds: [],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingInformation: ["no fresh quote"],
      direction: "WAIT",
      targets: [],
      expiry: "2026-08-15T18:00:00.000Z",
      evidenceQuality: "insufficient",
      versionManifestId: "ver-1",
    });
    store.occurrences.attachAuthoritativeRecords({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      decisionId: decision.id,
      orderIntentId: null,
      riskDecisionId: null,
      policyDecisionId: null,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
      gateDecisionId: null,
      decision,
      risk: null,
      policy: null,
      gate: null,
    });
    expect(() => recordPostTradeReview(store, {
      occurrenceId: occurrence.occurrenceId,
      recordedAt: LATER,
      learningRevisionIds: ["learn.missing"],
    })).toThrow(/Learning citation/);
    store.close();
  });

  it("upgrades a version 7 file by adding the review table and does not drop tables", () => {
    const dir = tempDir();
    const path = join(dir, "trading.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        environment TEXT NOT NULL,
        partition_key TEXT NOT NULL
      );
      INSERT INTO schema_meta (id, version, environment, partition_key) VALUES (1, 7, 'PAPER', 'xauusd/PAPER');
    `);
    db.close();
    const store = openTradingStore({ path, environment: "PAPER" });
    expect(store.schemaVersion).toBe(8);
    expect(store.reviews.readLatest("occ.absent")).toBe("missing");
    store.close();
    const schema = readFileSync(new URL("../persistence/schema.ts", import.meta.url), "utf8");
    expect(schema).not.toMatch(/\bDROP\s+(TABLE|INDEX|VIEW)\b/i);
    const review = readFileSync(new URL("./record.ts", import.meta.url), "utf8");
    expect(review).not.toContain("provider.submit");
    expect(review).not.toContain("killSwitches.write");
  });
});

describe("native tool seal", () => {
  it("fails closed when an occurrence id has no open store", () => {
    expect(() => sealNativeToolTurn({
      occurrenceId: "occ.missing",
      runtimeThreadId: "thread-missing",
      agentRunId: "run.missing",
    } as XauUsdToolSession)).toThrow(/Failing closed/);
  });

  it("seals the model's decision onto the native occurrence and does not submit", async () => {
    const dir = tempDir();
    const path = join(dir, "trading.db");
    const provider = createDeterministicXauUsdProvider({
      providerId: "explicit-paper-feed",
      environment: "PAPER",
      successProvenance: "LIVE",
      quote: {
        ok: true,
        providerTimestamp: "2026-08-15T14:29:30.000Z",
        provenance: "LIVE",
        instrument: "XAUUSD",
        quote: { bid: 4630, ask: 4633 },
      },
    });
    await dispatchXauUsdRoutineTurn({
      marker: { environment: "PAPER", autonomyLevel: 4, permissions: ["market.read", "decision.propose"] },
      routineId: "routine-1",
      routineRunId: "run-seal",
      threadId: "thread-seal",
      driverKind: "openai-compat",
      env: { OMB_XAUUSD_STORE_PATH: path, OMB_XAUUSD_ENVIRONMENT: "PAPER" },
      marketDataProvider: provider,
      startedAt: AT,
      startTurn: async () => {
        const grant = bindXauUsdProviderTurn({
          threadId: "thread-seal",
          providerTurnId: "turn-seal",
          modelProvider: "openai-compat",
          modelId: "fixture-model",
          observedAt: AT,
        });
        if (!grant) throw new Error("grant missing");
        const session = createXauUsdToolSession(grant);
        const signal = new AbortController().signal;
        const quote = await session.execute("get_xauusd_quote", {}, signal);
        expect(quote.ok).toBe(true);
        const quoted = JSON.parse(quote.text) as { snapshotId: string; contextId: string };
        const proposed = await session.execute("propose_decision", {
          thesis: "NO_TRADE from the sealed quote.",
          contextId: quoted.contextId,
          snapshotId: quoted.snapshotId,
          evidenceIds: [],
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          missingInformation: [],
          direction: "NO_TRADE",
          targets: [],
          expiry: "2026-08-15T18:00:00.000Z",
          evidenceQuality: "low",
        }, signal);
        expect(proposed.ok).toBe(true);
        sealNativeToolTurn(session);
      },
    });
    const store = openTradingStore({ path, environment: "PAPER" });
    const occurrence = store.occurrences.readByRoutineRun("run-seal");
    expect(occurrence?.decisionId).toBeTruthy();
    expect(occurrence?.executionRequestId).toBeNull();
    const sealed = occurrence?.decisionId ? store.artifacts.readDecision(occurrence.decisionId) : "missing";
    expect(sealed).toMatchObject({ direction: "NO_TRADE", thesis: "NO_TRADE from the sealed quote." });
    expect(store.readEvents().some((event) => event.type === "decision.created")).toBe(true);
    store.close();
    const runtime = readFileSync(new URL("../occurrence/runtime.ts", import.meta.url), "utf8");
    expect(runtime).not.toContain("provider.submit");
    expect(runtime).not.toContain("submitAuthorizedExecution");
  });
});
