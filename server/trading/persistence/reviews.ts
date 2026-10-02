import type { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, seal } from "../../../shared/trading/ids.ts";
import { canonicalJson } from "../replay/hash.ts";
import { TRADING_REVIEW_VERSION, type TradingReview } from "../review/record.ts";

export interface ReviewRepository {
  append(review: TradingReview): { readonly inserted: boolean };
  readLatest(occurrenceId: string): TradingReview | "missing" | "malformed";
}

export function createReviewRepository(db: DatabaseSync, environment: TradingEnvironment): ReviewRepository {
  return {
    append(review) {
      assertNoSecretFields(review, "trading review");
      if (review.environment !== environment || review.schemaVersion !== TRADING_REVIEW_VERSION) {
        throw new TradingDomainError("trading_store_rejected", "Trading review was rejected. Failing closed.");
      }
      const payload = canonicalJson(review);
      const existing = db.prepare(
        "SELECT payload_json FROM trading_reviews WHERE review_id = ?",
      ).get(review.reviewId) as { payload_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.payload_json !== payload) {
          throw new TradingDomainError("trading_store_rejected", "Trading review is immutable. Failing closed.");
        }
        return { inserted: false };
      }
      const occupied = db.prepare(
        "SELECT review_id FROM trading_reviews WHERE occurrence_id = ? AND revision = ?",
      ).get(review.occurrenceId, review.revision) as { review_id: string } | undefined;
      if (occupied !== undefined) {
        throw new TradingDomainError("trading_store_rejected", "Trading review revision is immutable. Failing closed.");
      }
      db.prepare(
        `INSERT INTO trading_reviews (
          review_id, occurrence_id, agent_run_id, environment, revision, supersedes, recorded_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        review.reviewId,
        review.occurrenceId,
        review.agentRunId,
        review.environment,
        review.revision,
        review.supersedes,
        review.recordedAt,
        payload,
      );
      return { inserted: true };
    },
    readLatest(occurrenceId) {
      const row = db.prepare(
        `SELECT payload_json FROM trading_reviews
         WHERE occurrence_id = ? AND environment = ?
         ORDER BY revision DESC
         LIMIT 1`,
      ).get(occurrenceId, environment) as { payload_json: string } | undefined;
      if (row === undefined) return "missing";
      try {
        const parsed = JSON.parse(row.payload_json) as TradingReview;
        assertNoSecretFields(parsed, "trading review");
        if (parsed.schemaVersion !== TRADING_REVIEW_VERSION || parsed.occurrenceId !== occurrenceId || parsed.environment !== environment) {
          return "malformed";
        }
        return seal(parsed);
      } catch (error) {
        if (error instanceof TradingDomainError && error.code === "credentials_forbidden") throw error;
        return "malformed";
      }
    },
  };
}
