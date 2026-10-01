import type { ApprovalMode } from "../../../shared/approval-mode.ts";
import type { AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { RuntimeEvent } from "../../../shared/runtime-events.ts";
import type { MarketClock } from "../infrastructure/market_data/model.ts";
import type { XauUsdMarketDataProvider } from "../infrastructure/market_data/provider.ts";
import type { TradingPermission } from "./catalog.ts";
import type { ModelRoutingPolicy, TradingTaskClass } from "./routing.ts";

/** Ids copied from the OpenMausBot turn. The trading layer does not mint a second turn. */
export interface XauUsdRuntimeLink {
  readonly runtimeThreadId: string;
  readonly runtimeTurnId: string;
  nextRuntimeEventId(): string;
  nextTradingEventId(): string;
  nextRecordId(): string;
}

export interface SpecialistConsultation {
  readonly specialty: "technical" | "macro" | "regime" | "trade_management";
  readonly question: string;
}

/** Opt-in grant for one investigation. Ordinary chat does not carry this.
 * `approvalMode` is stored so callers can see it is not a trading permission. */
export interface XauUsdTurnGrant {
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly autonomyLevel: AutonomyLevel;
  readonly permissions: readonly TradingPermission[];
  readonly approvalMode?: ApprovalMode;
  readonly clock: MarketClock;
  readonly provider: XauUsdMarketDataProvider;
  readonly correlation: XauUsdRuntimeLink;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly routing?: {
    readonly policy: ModelRoutingPolicy;
    readonly taskClass: TradingTaskClass;
    readonly availableModelIds: readonly string[];
  };
  readonly askSpecialist?: (input: SpecialistConsultation) => Promise<{ readonly text: string }>;
  emitRuntime?(event: RuntimeEvent): void;
}
