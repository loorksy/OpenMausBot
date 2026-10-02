import { parseMetaApiAccountBinding, type MetaApiAccountBinding } from "./binding.ts";
import { metaApiExitBody, metaApiTradeBody, type BrokerCommand } from "./command.ts";
import type { BrokerSubmitResult, MetaApiTransport, XauUsdExecutionProvider } from "./provider.ts";
import { translateMetaApiTradeResponse } from "./translate.ts";

/** MetaApi credentials stay in this closure. They are not fields on the provider. */
export function createMetaApiExecutionAdapter(input: {
  readonly binding: unknown;
  readonly token: string;
  readonly accountId: string;
  readonly transport: MetaApiTransport;
}): XauUsdExecutionProvider {
  const binding = parseMetaApiAccountBinding(input.binding);
  const token = typeof input.token === "string" ? input.token : "";
  const accountId = typeof input.accountId === "string" ? input.accountId : "";
  const configured = binding !== null && token.length > 0 && accountId.length > 0;
  return {
    providerId: "metaapi-cloud",
    bindingId: binding?.bindingId ?? "unbound",
    configured,
    submit: (command) => sendOnce(binding, token, accountId, configured, input.transport, command),
  };
}

async function sendOnce(
  binding: MetaApiAccountBinding | null,
  token: string,
  accountId: string,
  configured: boolean,
  transport: MetaApiTransport,
  command: BrokerCommand,
): Promise<BrokerSubmitResult> {
  if (!configured || binding === null) return credentialsMissing();
  const body = command.actionType === "POSITION_CLOSE_ID" ? metaApiExitBody(command) : metaApiTradeBody(command);
  if (body === null) {
    return { kind: "rejected", brokerRequestId: null, brokerCode: "ORDER_NOT_REPRESENTABLE", fillPrice: null, fillVolume: null, brokerFillId: null };
  }
  let response;
  try {
    response = await transport({ region: binding.region, accountId, token, body });
  } catch {
    return unknown();
  }
  if (response.kind === "timeout") return unknown();
  if (response.status === 401 || response.status === 403) {
    return { kind: "rejected", brokerRequestId: null, brokerCode: "BROKER_AUTH_REJECTED", fillPrice: null, fillVolume: null, brokerFillId: null };
  }
  if (response.status !== 200 && response.status !== 400) return unknown();
  const translated = translateMetaApiTradeResponse(response.body, command.volume);
  if (translated.kind === "accepted") {
    return {
      kind: "accepted",
      brokerRequestId: translated.brokerRequestId,
      brokerCode: translated.brokerCode,
      fillPrice: null,
      fillVolume: null,
      brokerFillId: null,
    };
  }
  if (translated.kind === "rejected") {
    return {
      kind: "rejected",
      brokerRequestId: translated.brokerRequestId,
      brokerCode: translated.brokerCode,
      fillPrice: null,
      fillVolume: null,
      brokerFillId: null,
    };
  }
  if (translated.kind === "filled" && translated.fillPrice !== null && translated.fillVolume !== null && translated.brokerFillId !== null) {
    return {
      kind: "filled",
      brokerRequestId: translated.brokerRequestId,
      brokerCode: translated.brokerCode,
      fillPrice: translated.fillPrice,
      fillVolume: translated.fillVolume,
      brokerFillId: translated.brokerFillId,
    };
  }
  return unknown();
}

function unknown(): BrokerSubmitResult {
  return { kind: "unknown", brokerRequestId: null, brokerCode: null, fillPrice: null, fillVolume: null, brokerFillId: null };
}

function credentialsMissing(): BrokerSubmitResult {
  return { kind: "credentials_missing", brokerRequestId: null, brokerCode: null, fillPrice: null, fillVolume: null, brokerFillId: null };
}
