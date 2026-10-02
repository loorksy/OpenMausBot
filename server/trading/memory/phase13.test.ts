import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingStore } from "../persistence/store.ts";
import { proposeLearningChange, tradingMemoryRecord } from "./record.ts";

const AT = "2026-08-15T14:30:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("phase 13 trading memory", () => {
  it("appends facts, interpretations, and feedback without rewriting history", () => {
    const dir = mkdtempSync(join(tmpdir(), "xauusd-memory-"));
    dirs.push(dir);
    const store = openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
    const fact = tradingMemoryRecord({
      occurrenceId: "occ-1",
      agentRunId: "run-1",
      environment: "PAPER",
      kind: "FACT",
      revision: 1,
      supersedes: null,
      recordedAt: AT,
      body: "Gold traded through 4632.5.",
    });
    const interpretation = tradingMemoryRecord({
      occurrenceId: "occ-1",
      agentRunId: "run-1",
      environment: "PAPER",
      kind: "INTERPRETATION",
      revision: 1,
      supersedes: null,
      recordedAt: AT,
      body: "The thesis expected continuation.",
    });
    const feedback = tradingMemoryRecord({
      ...interpretation,
      kind: "USER_FEEDBACK",
      body: "The user marked the scenario invalid.",
    });
    expect(store.memory.append(fact).inserted).toBe(true);
    expect(store.memory.append(fact).inserted).toBe(false);
    expect(store.memory.append(interpretation).inserted).toBe(true);
    expect(store.memory.append(feedback).inserted).toBe(true);
    expect(() => store.memory.append({ ...fact, body: "rewritten" })).toThrow(/immutable/i);
    const rows = store.memory.read("occ-1");
    expect(rows.map((row) => row.kind)).toEqual(["FACT", "INTERPRETATION", "USER_FEEDBACK"]);
    expect(rows[0]?.body).toBe("Gold traded through 4632.5.");
    expect(JSON.stringify(rows)).not.toContain("metaapi-token");
    store.close();
  });

  it("rejects a learning change that would edit risk, policy, or the kill switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "xauusd-learn-"));
    dirs.push(dir);
    const store = openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
    const blocked = store.memory.appendLearning({
      target: "prompt",
      fields: ["maxRiskPercent", "killSwitch"],
      note: "loosen risk",
      recordedAt: AT,
    });
    expect(blocked).toEqual({ accepted: false, reason: "SAFETY_IMMUTABLE" });
    const allowed = store.memory.appendLearning({
      target: "retrieval",
      fields: ["evidence"],
      note: "prefer the latest reconciled snapshot",
      recordedAt: AT,
    });
    expect(allowed.accepted).toBe(true);
    expect(proposeLearningChange({
      target: "policy",
      fields: [],
      note: "skip approval",
      recordedAt: AT,
    }).accepted).toBe(false);
    store.close();
  });
});
