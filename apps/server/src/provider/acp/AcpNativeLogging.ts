import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { causeErrorTag, errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

function structuralMethod(value: string): string {
  return value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value) ? value : "unknown";
}

const MAX_DESCRIBED_ENVELOPES = 8;
const MAX_STRUCTURAL_ID_LENGTH = 64;

/**
 * JSON-RPC ids are protocol-generated correlation handles, never user content,
 * so they are safe to record. Anything that does not look like one is dropped
 * rather than guessed at.
 */
function structuralRequestId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_STRUCTURAL_ID_LENGTH &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

/**
 * Extracts only the routing envelope of a protocol message — tag, method, and
 * correlation id. Params and results are deliberately never read, so a message
 * can be identified in a stalled session without its content reaching the log.
 */
function describeEnvelope(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const method =
    typeof record.tag === "string"
      ? record.tag
      : typeof record.method === "string"
        ? record.method
        : undefined;
  const requestId = structuralRequestId(record.id) ?? structuralRequestId(record.requestId);
  const described = {
    ...(typeof record._tag === "string" ? { messageTag: errorTag(record) } : {}),
    ...(method !== undefined ? { method: structuralMethod(method) } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
  return Object.keys(described).length > 0 ? described : undefined;
}

function describeEnvelopes(
  value: unknown,
): ReadonlyArray<Readonly<Record<string, unknown>>> | undefined {
  const values = Array.isArray(value) ? value : [value];
  const described = values
    .slice(0, MAX_DESCRIBED_ENVELOPES)
    .map(describeEnvelope)
    .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== undefined);
  return described.length > 0 ? described : undefined;
}

/** Raw protocol frames arrive as ndjson, so each line is parsed independently. */
function describeRawFrame(
  raw: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> | undefined {
  const described: Array<Readonly<Record<string, unknown>>> = [];
  for (const line of raw.split("\n")) {
    if (described.length >= MAX_DESCRIBED_ENVELOPES) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    described.push(...(describeEnvelopes(parsed) ?? []));
  }
  return described.length > 0 ? described.slice(0, MAX_DESCRIBED_ENVELOPES) : undefined;
}

export function summarizeAcpNativePayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (payload === null) return { valueType: "null" };
  if (typeof payload === "string") {
    const messages = describeRawFrame(payload);
    return {
      valueType: "string",
      byteLength: new TextEncoder().encode(payload).byteLength,
      ...(messages ? { messages } : {}),
    };
  }
  if (payload instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: payload.byteLength };
  }
  if (Array.isArray(payload)) {
    const messages = describeEnvelopes(payload);
    return {
      valueType: "array",
      itemCount: payload.length,
      ...(messages ? { messages } : {}),
    };
  }
  if (typeof payload !== "object") {
    return { valueType: typeof payload };
  }

  try {
    const record = payload as Record<string, unknown>;
    return {
      valueType: "object",
      fieldCount: Object.keys(record).length,
      ...describeEnvelope(record),
    };
  } catch {
    return { valueType: "object" };
  }
}

function formatRequestLogPayload(event: AcpSessionRuntime.AcpSessionRequestLogEvent) {
  return {
    method: structuralMethod(event.method),
    status: event.status,
    request: summarizeAcpNativePayload(event.payload),
    ...(event.result !== undefined ? { result: summarizeAcpNativePayload(event.result) } : {}),
    ...(event.cause !== undefined
      ? {
          errorTag: causeErrorTag(event.cause),
          reasonCount: event.cause.reasons.length,
        }
      : {}),
  };
}

function formatProtocolLogPayload(event: EffectAcpProtocol.AcpProtocolLogEvent) {
  return {
    direction: event.direction,
    stage: event.stage,
    payload: summarizeAcpNativePayload(event.payload),
  };
}

export const makeAcpNativeLoggerFactory = Effect.fn("makeAcpNativeLoggerFactory")(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
  }): Pick<AcpSessionRuntime.AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> => {
    const writeNativeAcpLog = (logInput: {
      readonly kind: "request" | "protocol";
      readonly payload: unknown;
    }) =>
      Effect.gen(function* () {
        if (!input.nativeEventLogger) return;
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* input.nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* crypto.randomUUIDv4,
              kind: logInput.kind,
              provider: input.provider,
              createdAt: observedAt,
              threadId: input.threadId,
              payload: logInput.payload,
            },
          },
          input.threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to write native ACP event log.", {
                errorTag: causeErrorTag(cause),
                reasonCount: cause.reasons.length,
                provider: input.provider,
                threadId: input.threadId,
              }),
        ),
      );

    return {
      requestLogger: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
        writeNativeAcpLog({
          kind: "request",
          payload: formatRequestLogPayload(event),
        }),
      ...(input.nativeEventLogger
        ? {
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                writeNativeAcpLog({
                  kind: "protocol",
                  payload: formatProtocolLogPayload(event),
                }),
            } satisfies NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]>,
          }
        : {}),
    };
  };
});
