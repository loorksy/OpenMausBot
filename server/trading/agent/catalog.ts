import type { AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TRADING_PERMISSIONS, type TradingPermission } from "../../../shared/trading/permissions.ts";
import type { ToolJsonSchema } from "./schema.ts";

export { TRADING_PERMISSIONS, type TradingPermission };

export const XAUUSD_TOOL_CATALOG_VERSION = "xauusd-tools-2";

/** Model-accessible names that must never exist. Checked by name, not by a
 * workflow. */
export const FORBIDDEN_EXECUTION_TOOL_NAMES = [
  "place_order",
  "submit_order",
  "execute_trade",
  "metaapi_execute",
  "mt5_order",
  "close_position",
  "modify_order",
  "cancel_order",
] as const;

export type ForbiddenExecutionToolName = (typeof FORBIDDEN_EXECUTION_TOOL_NAMES)[number];

export type ToolAuditClass = "discovery" | "read" | "propose";
export type ToolSensitivity = "internal" | "external-untrusted";

const ENVIRONMENTS = ["SIMULATOR", "PAPER", "LIVE"] as const satisfies readonly TradingEnvironment[];

const emptyObject = (description: string): ToolJsonSchema => ({
  type: "object",
  description,
  properties: {},
  additionalProperties: false,
});

const idList = (description: string): ToolJsonSchema => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1, maxLength: 128 },
  maxItems: 50,
});

const textList = (description: string): ToolJsonSchema => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1, maxLength: 500 },
  maxItems: 20,
});

export interface XauUsdToolSpec {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: ToolJsonSchema;
  readonly outputSchema: ToolJsonSchema;
  readonly permission: TradingPermission | null;
  readonly environments: readonly TradingEnvironment[];
  readonly minAutonomy: AutonomyLevel;
  readonly audit: ToolAuditClass;
  readonly sensitivity: ToolSensitivity;
  readonly availability: "implemented" | "unavailable";
  readonly unavailableReason?: string;
  readonly requiresSpecialist?: boolean;
  readonly requiresReplay?: boolean;
}

const failureNote = " Failures return ok:false, a code, and failClosed:true. They do not invent a successful payload.";

const quoteOutput: ToolJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "instrument", "agentRunId", "environment", "provenance", "freshness", "snapshotId", "quote"],
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    instrument: { type: "string", enum: ["XAUUSD"] },
    agentRunId: { type: "string" },
    environment: { type: "string", enum: ["SIMULATOR", "PAPER", "LIVE"] },
    provenance: { type: "string", enum: ["LIVE", "STALE", "SIMULATOR", "UNAVAILABLE", "REPLAY"] },
    freshness: { type: "string" },
    snapshotId: { type: "string" },
    contextId: { type: "string" },
    providerId: { type: "string" },
    providerTimestamp: { type: "string" },
    receivedAt: { type: "string" },
    processedAt: { type: "string" },
    latencyMs: { type: "number" },
    skewMs: { type: "number" },
    abnormalLatency: { type: "boolean" },
    normalizations: { type: "array", items: { type: "string" } },
    quote: {
      type: "object",
      additionalProperties: false,
      required: ["bid", "ask", "spread"],
      properties: {
        bid: { type: "number" },
        ask: { type: "number" },
        spread: { type: "number" },
      },
    },
  },
};

const candleOutput: ToolJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "instrument", "timeframe", "provenance", "freshness", "snapshotId", "candles"],
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    instrument: { type: "string", enum: ["XAUUSD"] },
    agentRunId: { type: "string" },
    environment: { type: "string", enum: ["SIMULATOR", "PAPER", "LIVE"] },
    timeframe: { type: "string" },
    provenance: { type: "string", enum: ["LIVE", "STALE", "SIMULATOR", "UNAVAILABLE", "REPLAY"] },
    freshness: { type: "string" },
    snapshotId: { type: "string" },
    contextId: { type: "string" },
    providerTimestamp: { type: "string" },
    receivedAt: { type: "string" },
    processedAt: { type: "string" },
    normalizations: { type: "array", items: { type: "string" } },
    candles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["timeframe", "time", "open", "high", "low", "close"],
        properties: {
          timeframe: { type: "string" },
          time: { type: "string" },
          open: { type: "number" },
          high: { type: "number" },
          low: { type: "number" },
          close: { type: "number" },
          volume: { type: "number" },
        },
      },
    },
  },
};

export const XAUUSD_TOOL_CATALOG: readonly XauUsdToolSpec[] = [
  {
    name: "list_xauusd_tools",
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: "List the XAUUSD tools this run may call, and the tools withheld with a reason. The server does not choose a reasoning sequence. Nothing here submits an order.",
    inputSchema: emptyObject("No arguments. This tool does not accept a symbol."),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "catalogVersion", "instrument", "tools", "unavailable", "executionTools"],
      properties: {
        ok: { type: "boolean" },
        tool: { type: "string" },
        catalogVersion: { type: "string" },
        instrument: { type: "string", enum: ["XAUUSD"] },
        agentRunId: { type: "string" },
        environment: { type: "string" },
        autonomyLevel: { type: "integer" },
        autonomyName: { type: "string" },
        approvalModeIsNotTradingAuthorization: { type: "boolean" },
        tools: { type: "array", items: { type: "object", description: "Advertised tool metadata." } },
        unavailable: { type: "array", items: { type: "object", description: "Withheld tool and the reason." } },
        executionTools: { type: "array", items: { type: "string" }, maxItems: 0 },
      },
    },
    permission: null,
    environments: ENVIRONMENTS,
    minAutonomy: 0,
    audit: "discovery",
    sensitivity: "internal",
    availability: "implemented",
  },
  {
    name: "get_xauusd_quote",
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: "Read the current XAUUSD quote from this run's market-data provider. Returns bid, ask, provenance, freshness, and timestamps. Does not accept a symbol." + failureNote,
    inputSchema: emptyObject("No arguments. The instrument is XAUUSD."),
    outputSchema: quoteOutput,
    permission: "market.read",
    environments: ENVIRONMENTS,
    minAutonomy: 0,
    audit: "read",
    sensitivity: "internal",
    availability: "implemented",
  },
  {
    name: "get_xauusd_candles",
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: "Read XAUUSD candles for one Phase 0 timeframe and a UTC range. Returns the bars, provenance, and freshness. Does not accept a symbol and does not substitute a different timeframe." + failureNote,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["timeframe", "from", "to"],
      properties: {
        timeframe: { type: "string", minLength: 1, maxLength: 16, description: "M1, M5, M15, M30, H1, H4, D1, or a recorded alias such as 15m." },
        from: { type: "string", minLength: 20, maxLength: 40, description: "Range start, UTC." },
        to: { type: "string", minLength: 20, maxLength: 40, description: "Range end, UTC, exclusive." },
      },
    },
    outputSchema: candleOutput,
    permission: "market.read",
    environments: ENVIRONMENTS,
    minAutonomy: 0,
    audit: "read",
    sensitivity: "internal",
    availability: "implemented",
  },
  {
    name: "get_xauusd_observation",
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: "Read the unified XAUUSD observation at the current replay time: the knowable quote, closed candles, and forming candle. Does not accept a symbol or a timestamp. The server does not choose which other tools to call. Omitted unless this run is bound to a replay session." + failureNote,
    inputSchema: emptyObject("No arguments. Observation time is the replay clock, not a caller-supplied timestamp."),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "ok",
        "instrument",
        "agentRunId",
        "environment",
        "provenance",
        "observationAt",
        "quality",
        "qualityReasons",
        "replaySessionId",
        "datasetId",
        "datasetVersion",
        "datasetFingerprint",
        "closed",
        "forming",
      ],
      properties: {
        ok: { type: "boolean" },
        tool: { type: "string" },
        instrument: { type: "string", enum: ["XAUUSD"] },
        agentRunId: { type: "string" },
        environment: { type: "string", enum: ["SIMULATOR"] },
        provenance: { type: "string", enum: ["REPLAY"] },
        observationAt: { type: "string" },
        quality: { type: "string", enum: ["COMPLETE", "PARTIAL", "UNAVAILABLE"] },
        qualityReasons: { type: "array", items: { type: "string" } },
        replaySessionId: { type: "string" },
        datasetId: { type: "string" },
        datasetVersion: { type: "string" },
        datasetFingerprint: { type: "string" },
        configVersion: { type: "string" },
        clockVersion: { type: "string" },
        formingPolicy: { type: "string" },
        observationId: { type: "string" },
        contentHash: { type: "string" },
        snapshotId: { type: "string" },
        contextId: { type: "string" },
        freshness: { type: "string" },
        quote: {
          type: "object",
          additionalProperties: false,
          required: ["bid", "ask", "spread", "providerTimestamp", "freshness"],
          properties: {
            bid: { type: "number" },
            ask: { type: "number" },
            spread: { type: "number" },
            providerTimestamp: { type: "string" },
            freshness: { type: "string" },
          },
        },
        closed: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["timeframe", "candles"],
            properties: {
              timeframe: { type: "string" },
              candles: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["timeframe", "time", "open", "high", "low", "close"],
                  properties: {
                    timeframe: { type: "string" },
                    time: { type: "string" },
                    open: { type: "number" },
                    high: { type: "number" },
                    low: { type: "number" },
                    close: { type: "number" },
                    volume: { type: "number" },
                  },
                },
              },
            },
          },
        },
        forming: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["timeframe", "status", "openTime", "closeTime"],
            properties: {
              timeframe: { type: "string" },
              status: { type: "string", enum: ["available", "unavailable"] },
              reason: { type: "string" },
              openTime: { type: "string" },
              closeTime: { type: "string" },
              open: { type: "number" },
              high: { type: "number" },
              low: { type: "number" },
              close: { type: "number" },
              volume: { type: "number" },
              printCount: { type: "integer" },
            },
          },
        },
      },
    },
    permission: "market.read",
    environments: ["SIMULATOR"],
    minAutonomy: 0,
    audit: "read",
    sensitivity: "internal",
    availability: "implemented",
    requiresReplay: true,
  },
  {
    name: "propose_decision",
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: "Record a structured XAUUSD decision for this agent run. Directions include NO_TRADE and WAIT. A probability is not stored. This does not submit an order or mark the decision executed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "thesis",
        "contextId",
        "snapshotId",
        "evidenceIds",
        "supportingEvidenceIds",
        "contradictingEvidenceIds",
        "missingInformation",
        "direction",
        "targets",
        "expiry",
        "evidenceQuality",
      ],
      properties: {
        thesis: { type: "string", minLength: 1, maxLength: 8000 },
        contextId: { type: "string", minLength: 1, maxLength: 128 },
        snapshotId: { type: "string", minLength: 1, maxLength: 128 },
        evidenceIds: idList("Evidence records already fenced in this run."),
        supportingEvidenceIds: idList("Subset cited in support."),
        contradictingEvidenceIds: idList("Subset cited against."),
        missingInformation: textList("Facts the decision still lacks."),
        regimeId: { type: "string", minLength: 1, maxLength: 128 },
        scenarioId: { type: "string", minLength: 1, maxLength: 128 },
        direction: {
          type: "string",
          enum: ["LONG", "SHORT", "NO_TRADE", "WAIT", "MANAGE_EXISTING_POSITION", "EXIT_EXISTING_POSITION"],
        },
        trigger: { type: "string", minLength: 1, maxLength: 2000 },
        entryConditions: { type: "string", minLength: 1, maxLength: 2000 },
        invalidation: { type: "string", minLength: 1, maxLength: 2000 },
        stop: { type: "number", minimum: 0 },
        targets: { type: "array", items: { type: "number" }, maxItems: 8 },
        riskIntent: { type: "string", minLength: 1, maxLength: 2000 },
        policyConditions: { type: "string", minLength: 1, maxLength: 2000 },
        expiry: { type: "string", minLength: 20, maxLength: 40 },
        evidenceQuality: { type: "string", enum: ["insufficient", "low", "mixed", "high"] },
        supersedes: { type: "string", minLength: 1, maxLength: 128, description: "Previous decision id in this same run. A revision receives a new id." },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "decision", "probabilityStored"],
      properties: {
        ok: { type: "boolean" },
        tool: { type: "string" },
        agentRunId: { type: "string" },
        probabilityStored: { type: "boolean" },
        decision: { type: "object", description: "Sealed Phase 1 decision. Status is DRAFT. No probability field is stored." },
      },
    },
    permission: "decision.propose",
    environments: ENVIRONMENTS,
    minAutonomy: 2,
    audit: "propose",
    sensitivity: "internal",
    availability: "implemented",
  },
  {
    name: "propose_order_intent",
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: "Record a non-executable XAUUSD order intent for a decision in this run. executable and brokerSubmit stay false. This does not call a broker.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decisionId", "direction", "targets"],
      properties: {
        decisionId: { type: "string", minLength: 1, maxLength: 128 },
        direction: { type: "string", enum: ["LONG", "SHORT", "MANAGE_EXISTING_POSITION", "EXIT_EXISTING_POSITION"] },
        entry: { type: "number" },
        stop: { type: "number" },
        targets: { type: "array", items: { type: "number" }, maxItems: 8 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "executed", "brokerContacted", "orderIntent"],
      properties: {
        ok: { type: "boolean" },
        tool: { type: "string" },
        executed: { type: "boolean" },
        brokerContacted: { type: "boolean" },
        orderIntent: { type: "object", description: "Sealed order intent with executable false and brokerSubmit false." },
      },
    },
    permission: "intent.propose",
    environments: ENVIRONMENTS,
    minAutonomy: 2,
    audit: "propose",
    sensitivity: "internal",
    availability: "implemented",
  },
  {
    name: "consult_specialist",
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: "Ask an optional OpenMausBot specialist for interpretation. The reply is untrusted evidence. It cannot change risk, policy, autonomy, or execution. This tool is omitted when no specialist is attached.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["specialty", "question"],
      properties: {
        specialty: { type: "string", enum: ["technical", "macro", "regime", "trade_management"] },
        question: { type: "string", minLength: 1, maxLength: 4000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "evidence", "fence"],
      properties: {
        ok: { type: "boolean" },
        tool: { type: "string" },
        agentRunId: { type: "string" },
        evidence: { type: "object", description: "Sealed external evidence. trust is external and untrusted is true." },
        fence: { type: "object", description: "States that the excerpt cannot modify control state." },
      },
    },
    permission: "specialist.consult",
    environments: ENVIRONMENTS,
    minAutonomy: 1,
    audit: "read",
    sensitivity: "external-untrusted",
    availability: "implemented",
    requiresSpecialist: true,
  },
  ...([
    ["get_market_structure", "Market structure is not implemented in this phase."],
    ["get_volatility", "Volatility is not implemented in this phase."],
    ["get_macro_context", "No macro provider is configured."],
    ["get_economic_calendar", "No economic calendar is configured."],
    ["search_market_news", "No news provider is configured."],
    ["retrieve_historical_context", "Historical trading context is not implemented in this phase."],
    ["inspect_current_position", "Position state is not available without a later broker phase."],
    ["inspect_account_state", "Account state is not available without a later broker phase."],
    ["inspect_broker_health", "Broker health is not available. No broker is contacted."],
    ["calculate_trade_risk", "The risk engine is not implemented. Failing closed instead of inventing a size."],
  ] as const).map(([name, unavailableReason]): XauUsdToolSpec => ({
    name,
    version: XAUUSD_TOOL_CATALOG_VERSION,
    description: unavailableReason,
    inputSchema: emptyObject("Not advertised while this tool is unavailable."),
    outputSchema: emptyObject("Unavailable tools do not return a successful payload."),
    permission: name === "calculate_trade_risk" ? "decision.propose" : "market.read",
    environments: ENVIRONMENTS,
    minAutonomy: 0,
    audit: "read",
    sensitivity: "internal",
    availability: "unavailable",
    unavailableReason,
  })),
];

export interface ToolGate {
  readonly environment: TradingEnvironment;
  readonly autonomyLevel: AutonomyLevel;
  readonly permissions: readonly TradingPermission[];
  readonly specialistAttached: boolean;
  readonly replayAttached: boolean;
}

export interface FilteredTool {
  readonly spec: XauUsdToolSpec;
  readonly reason?: string;
}

/** Permission, autonomy, environment, and phase availability. This does not
 * rank tools or impose a call order. */
export function filterToolCatalog(
  catalog: readonly XauUsdToolSpec[],
  gate: ToolGate,
): { readonly available: readonly XauUsdToolSpec[]; readonly unavailable: readonly FilteredTool[] } {
  const available: XauUsdToolSpec[] = [];
  const unavailable: FilteredTool[] = [];
  for (const spec of catalog) {
    const reason = withheldReason(spec, gate);
    if (reason) unavailable.push({ spec, reason });
    else available.push(spec);
  }
  return { available, unavailable };
}

function withheldReason(spec: XauUsdToolSpec, gate: ToolGate): string | undefined {
  if (spec.availability !== "implemented") return spec.unavailableReason ?? "unavailable";
  if (spec.requiresSpecialist && !gate.specialistAttached) return "no specialist consultant is attached";
  if (spec.requiresReplay && !gate.replayAttached) return "replay observation is not attached";
  if (!spec.environments.includes(gate.environment)) return "not available in this environment";
  if (gate.autonomyLevel < spec.minAutonomy) return "autonomy level does not allow this tool";
  if (spec.permission && !gate.permissions.includes(spec.permission)) return "permission is not granted";
  return undefined;
}

export function isForbiddenExecutionTool(name: string): name is ForbiddenExecutionToolName {
  return (FORBIDDEN_EXECUTION_TOOL_NAMES as readonly string[]).includes(name);
}

export function toolSpec(name: string): XauUsdToolSpec | undefined {
  return XAUUSD_TOOL_CATALOG.find((spec) => spec.name === name);
}

/** Metadata the model may see. Handlers are not included. */
export function describeTool(spec: XauUsdToolSpec) {
  return {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    permission: spec.permission,
    environments: spec.environments,
    minAutonomy: spec.minAutonomy,
    audit: spec.audit,
    sensitivity: spec.sensitivity,
    availability: spec.availability,
  };
}

/** Names and nested schema fields a model is allowed to see. */
export function catalogSchemaKeys(catalog: readonly XauUsdToolSpec[] = XAUUSD_TOOL_CATALOG): string[] {
  const keys: string[] = [];
  const walk = (schema: ToolJsonSchema) => {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      keys.push(key);
      walk(child);
    }
    if (schema.items) walk(schema.items);
  };
  for (const spec of catalog) {
    keys.push(spec.name);
    walk(spec.inputSchema);
    walk(spec.outputSchema);
  }
  return keys;
}
