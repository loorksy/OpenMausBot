import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { seal } from "../../../shared/trading/ids.ts";
import type { EvaluationResult } from "./result.ts";

/** In-memory sealed results. A completed id is never replaced. */
export interface EvaluationArchive {
  put(result: EvaluationResult): void;
  get(evaluationRunId: string): EvaluationResult | undefined;
  list(): readonly EvaluationResult[];
}

export function createEvaluationArchive(): EvaluationArchive {
  const runs = new Map<string, EvaluationResult>();
  return {
    put(result) {
      if (runs.has(result.evaluationRunId)) {
        throw new TradingDomainError("evaluation_rejected", "evaluation run already archived");
      }
      runs.set(result.evaluationRunId, seal(result));
    },
    get(evaluationRunId) {
      return runs.get(evaluationRunId);
    },
    list() {
      return [...runs.values()];
    },
  };
}
