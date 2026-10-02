import { contentHash } from "../replay/hash.ts";

/** Identity of one exact proposal. A changed field is a different binding.
 * This is not an approval and it does not execute. */
export const PROPOSAL_BINDING_VERSION = "xauusd-proposal-binding-1" as const;

export interface ProposalBindingFacts {
  readonly instrument: "XAUUSD";
  readonly agentRunId: string;
  readonly decisionId: string;
  readonly orderIntentId: string;
  readonly riskDecisionId: string;
  readonly policyDecisionId: string;
  readonly environment: string;
  readonly provenance: string;
  readonly direction: string;
  readonly entry: number;
  readonly stop: number;
  readonly targets: readonly number[];
  readonly requestedQuantity: number | null;
  readonly acceptedQuantity: number | null;
  readonly riskConfigId: string;
  readonly policyConfigId: string;
}

export function proposalBinding(facts: ProposalBindingFacts): string {
  return `bind.${contentHash({
    schema: PROPOSAL_BINDING_VERSION,
    ...facts,
  }).slice(0, 40)}`;
}
