import type { BrokerOrderCommand } from "./command.ts";
import { METAAPI_PROVIDER_ID } from "./binding.ts";

export interface BrokerSubmitResult {
  readonly kind: "accepted" | "rejected" | "filled" | "unknown" | "credentials_missing";
  readonly brokerRequestId: string | null;
  readonly brokerCode: string | null;
  readonly fillPrice: number | null;
  readonly fillVolume: number | null;
  readonly brokerFillId: string | null;
}

/** The only execution provider the domain will call. Credentials stay behind it. */
export interface XauUsdExecutionProvider {
  readonly providerId: typeof METAAPI_PROVIDER_ID;
  readonly bindingId: string;
  readonly configured: boolean;
  submit(command: BrokerOrderCommand): Promise<BrokerSubmitResult>;
}

export interface MetaApiTransportRequest {
  readonly region: string;
  readonly accountId: string;
  readonly token: string;
  readonly body: Readonly<Record<string, string | number>>;
}

export type MetaApiTransportResult =
  | { readonly kind: "response"; readonly status: number; readonly body: unknown }
  | { readonly kind: "timeout" };

/** Injected send function. The execution domain does not call the network itself. */
export type MetaApiTransport = (request: MetaApiTransportRequest) => Promise<MetaApiTransportResult>;
