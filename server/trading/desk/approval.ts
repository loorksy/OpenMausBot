import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import {
  settleNativeTradingApprovalFromEnvironment,
  tradingResponderId,
  type NativeApprovalResolution,
} from "../approval/native.ts";

/** Settles an open native trading approval. It does not submit an order. */
export function settleDeskApproval(
  env: Readonly<Record<string, string | undefined>>,
  auth: { readonly kind: string; readonly trust?: string; readonly session?: { readonly id?: string } },
  body: unknown,
): { readonly status: number; readonly body: { readonly error?: string; readonly state?: string; readonly reasons?: readonly string[]; readonly idempotent?: boolean } } {
  const responderId = tradingResponderId(auth);
  if (responderId === "unauthorized") return { status: 403, body: { error: "approval responder is not authorized" } };
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "approval body was rejected" } };
  }
  const record = body as { requestId?: unknown; answer?: unknown };
  if (typeof record.requestId !== "string" || !recordIdSchema.safeParse(record.requestId).success) {
    return { status: 400, body: { error: "approval request was rejected" } };
  }
  if (record.answer !== "approve" && record.answer !== "reject") return { status: 400, body: { error: "approval answer was rejected" } };
  const resolution: NativeApprovalResolution = {
    requestId: record.requestId,
    behavior: "answer",
    message: record.answer,
    source: "user",
    responderId,
    resolvedAt: new Date().toISOString(),
  };
  try {
    const settlement = settleNativeTradingApprovalFromEnvironment(env, resolution);
    if (settlement.kind !== "trading") return { status: 404, body: { error: "approval request was not found" } };
    return {
      status: 200,
      body: {
        state: settlement.decision.state,
        reasons: settlement.decision.reasons,
        idempotent: settlement.idempotent,
      },
    };
  } catch (error) {
    if (error instanceof TradingDomainError && error.code === "immutable_revision") {
      return { status: 409, body: { error: "approval was already resolved" } };
    }
    return { status: 400, body: { error: "approval was rejected" } };
  }
}
