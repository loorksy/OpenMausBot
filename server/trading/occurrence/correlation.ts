/** Ids already stored on a native trading occurrence.
 * `runtimeThreadId` is that thread. `runtimeTurnId` is that provider turn.
 * This does not mint a conversation, a turn, or a trading sequence. */
export interface NativeConversationCorrelation {
  readonly availability: "ATTACHED" | "NOT_AVAILABLE";
  readonly threadId: string | null;
  readonly runtimeThreadId: string | null;
  readonly providerTurnId: string | null;
  readonly runtimeTurnId: string | null;
  readonly occurrenceId: string | null;
  readonly agentRunId: string | null;
  readonly routineId: string | null;
  readonly routineRunId: string | null;
}

export interface NativeConversationSource {
  readonly threadId: string | null;
  readonly providerTurnId: string | null;
  readonly occurrenceId: string | null;
  readonly agentRunId: string | null;
  readonly routineId?: string | null;
  readonly routineRunId?: string | null;
  /** A caller asking about some other thread. It is never copied into the attachment. */
  readonly requestedThreadId?: string | null;
}

const UNATTACHED: NativeConversationCorrelation = {
  availability: "NOT_AVAILABLE",
  threadId: null,
  runtimeThreadId: null,
  providerTurnId: null,
  runtimeTurnId: null,
  occurrenceId: null,
  agentRunId: null,
  routineId: null,
  routineRunId: null,
};

function storedId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The room's conversation link. Both runtime names are the stored ids. */
export function correlateNativeConversation(input: NativeConversationSource): NativeConversationCorrelation {
  const threadId = storedId(input.threadId);
  const requested = storedId(input.requestedThreadId);
  const occurrenceId = storedId(input.occurrenceId);
  const agentRunId = storedId(input.agentRunId);
  const routineId = storedId(input.routineId);
  const routineRunId = storedId(input.routineRunId);
  const identity = { occurrenceId, agentRunId, routineId, routineRunId };
  if (threadId === null || (requested !== null && requested !== threadId)) {
    return { ...UNATTACHED, ...identity };
  }
  const providerTurnId = storedId(input.providerTurnId);
  return {
    availability: "ATTACHED",
    threadId,
    runtimeThreadId: threadId,
    providerTurnId,
    runtimeTurnId: providerTurnId,
    ...identity,
  };
}
