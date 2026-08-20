import {
  ApprovalRequestId,
  type DevinSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ServerProviderSlashCommand,
  type ThreadTokenUsageSnapshot,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  CurrentAcpElicitationCreateRequest,
  type CurrentAcpFormRequest,
  isCurrentFormRequest,
  makeCurrentAcpElicitationResponse,
  makeLegacyAcpElicitationResponse,
  mapAcpFormToUserInput,
  normalizeAcpFormAnswers,
} from "../acp/AcpElicitationCompatibility.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  acpTokenUsageEqual,
  normalizeAcpPromptUsage,
  normalizeAcpUsageUpdate,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory, summarizeAcpNativePayload } from "../acp/AcpNativeLogging.ts";
import {
  applyDevinAcpInteractionMode,
  applyDevinAcpModelSelection,
  currentDevinModelIdFromSessionSetup,
  makeDevinAcpRuntime,
  resolveDevinAcpBaseModelId,
} from "../acp/DevinAcpSupport.ts";
import { type DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_RESUME_VERSION = 1 as const;
const DEVIN_IDLE_LIVENESS_PROBE_AFTER = Duration.minutes(5);
const DEVIN_IDLE_LIVENESS_PROBE_TIMEOUT = Duration.seconds(2);

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface DevinAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly onSlashCommandsChanged?: (
    commands: ReadonlyArray<ServerProviderSlashCommand>,
  ) => Effect.Effect<void>;
  readonly authenticationTimeout?: Duration.Input;
  readonly idleLivenessProbeAfter?: Duration.Input;
  readonly idleLivenessProbeTimeout?: Duration.Input;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type AcpFormRequest =
  | CurrentAcpFormRequest
  | Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>;

type PendingUserInputResolution =
  | {
      readonly action: "accept";
      readonly answers: ProviderUserInputAnswers;
      readonly content: Readonly<Record<string, EffectAcpSchema.ElicitationContentValue>>;
    }
  | { readonly action: "decline" | "cancel"; readonly answers: {} };

interface PendingUserInput {
  readonly request: AcpFormRequest;
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
  readonly completed: Deferred.Deferred<void>;
  claimed: boolean;
}

interface DevinSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly runtimeMode: RuntimeMode;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly toolTurnIds: Map<string, TurnId>;
  readonly promptConfigurationSemaphore: Semaphore.Semaphore;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  /** Newest turn opened by sendTurn; mirrored into session.activeTurnId. */
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** In-flight prompt turns, oldest first. Devin's ACP server serializes
   * session/prompt, so the head is the wire-active prompt and untagged
   * session/update traffic attributes to it. A sendTurn during a running turn
   * is a steer: it opens its own new turn at the tail rather than continuing
   * the active one. */
  inFlightTurnIds: Array<TurnId>;
  currentModelId: string | undefined;
  lastTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastPromptSettledAtMillis: number;
  stopped: boolean;
}

const drainDevinAcpEvents = Effect.fn("drainDevinAcpEvents")(function* (input: {
  readonly threadId: ThreadId;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly notificationFiber: Fiber.Fiber<void, never>;
}) {
  return yield* Effect.raceFirst(
    input.acp.drainEvents,
    Effect.gen(function* () {
      const exit = yield* Fiber.await(input.notificationFiber);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/update",
        detail: "Devin notification consumer exited before queued ACP events were drained.",
        ...(Exit.isFailure(exit) ? { cause: Cause.squash(exit.cause) } : {}),
      });
    }),
  );
});

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.entries()),
    ([, pending]) =>
      Effect.gen(function* () {
        if (!pending.claimed) {
          pending.claimed = true;
          yield* Deferred.succeed(pending.resolution, { action: "cancel", answers: {} }).pipe(
            Effect.ignore,
          );
        }
        yield* Deferred.await(pending.completed).pipe(
          Effect.timeoutOption("5 seconds"),
          Effect.asVoid,
        );
      }),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: DevinSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: DevinSessionContext): TurnId | undefined =>
  ctx.inFlightTurnIds[0];

const resolveCallbackTurnId = (ctx: DevinSessionContext): TurnId | undefined =>
  ctx.inFlightTurnIds[0];

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, DevinSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

function parseDevinResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DEVIN_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/**
 * Devin overloads `allow_always` across options with very different blast
 * radii. A single request carries all of:
 *
 *   allow_session        "allow `git status` commands (this session)"
 *   allow_always         "always allow ... in `web-frontend-angularjs`"
 *   allow_always_global  "always allow ... in all projects"
 *   switch_bypass        "switch to bypass mode"
 *
 * `kind` cannot tell them apart, so taking the first match means Devin's array
 * ordering decides what gets selected. Today that happens to be the
 * session-scoped option; a reorder on their side would silently select bypass
 * mode and disable permission prompting altogether.
 *
 * Options that widen permission beyond the current session are therefore never
 * selectable here — neither automatically, nor by mapping a user's
 * "accept for session" choice onto them.
 */
const ESCALATING_PERMISSION_OPTION_IDS: ReadonlySet<string> = new Set([
  "switch_bypass",
  "allow_always_global",
]);

/** Preferred when several `allow_always` options survive the escalation filter. */
const SESSION_SCOPED_PERMISSION_OPTION_ID = "allow_session";

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const candidates = request.options.filter((entry) => {
    const optionId = entry.optionId.trim();
    return (
      entry.kind === kind && optionId.length > 0 && !ESCALATING_PERMISSION_OPTION_IDS.has(optionId)
    );
  });
  const preferred =
    candidates.find((entry) => entry.optionId.trim() === SESSION_SCOPED_PERMISSION_OPTION_ID) ??
    candidates[0];
  return preferred?.optionId.trim() || undefined;
}

export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  if (response === undefined) {
    return null;
  }
  return response.stopReason;
}

export function devinPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly inFlightTurnIds: ReadonlyArray<TurnId>;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    input.inFlightTurnIds.includes(input.turnId)
  );
}

export function makeDevinAdapter(devinSettings: DevinSettings, options?: DevinAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("devin");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const idleLivenessProbeAfter = Duration.fromInputUnsafe(
      options?.idleLivenessProbeAfter ?? DEVIN_IDLE_LIVENESS_PROBE_AFTER,
    );
    const idleLivenessProbeTimeout = Duration.fromInputUnsafe(
      options?.idleLivenessProbeTimeout ?? DEVIN_IDLE_LIVENESS_PROBE_TIMEOUT,
    );

    const sessions = new Map<ThreadId, DevinSessionContext>();
    const ownedThreadIds = new Set<ThreadId>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const stoppingAllRef = yield* Ref.make(false);
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Devin runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Devin ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const emitTokenUsage = Effect.fn("emitDevinTokenUsage")(function* (
      ctx: DevinSessionContext,
      turnId: TurnId | undefined,
      usage: ThreadTokenUsageSnapshot | undefined,
    ) {
      if (usage === undefined || acpTokenUsageEqual(ctx.lastTokenUsage, usage)) {
        return;
      }
      ctx.lastTokenUsage = usage;
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId,
        payload: { usage },
      });
    });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every in-flight turn and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx || liveCtx.acpSessionId !== expectedAcpSessionId) {
          return;
        }

        const emitTerminalEvent = (settledTurnId: TurnId) =>
          Effect.gen(function* () {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId: settledTurnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId: settledTurnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          });

        if (options?.settleAllPrompts) {
          // Interrupt/cancel: every in-flight turn is dropped. Only the
          // session's active turn earns a terminal event — turns superseded by
          // a steer already settled in the projector when the newer turn
          // started, and a terminal event for a non-active turn is rejected by
          // ingestion anyway.
          const activeTurnId = liveCtx.session.activeTurnId ?? liveCtx.activeTurnId;
          liveCtx.inFlightTurnIds = [];
          const canEmitTurnCompletion =
            liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
          const updatedAt = yield* nowIso;
          const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
          liveCtx.activeTurnId = undefined;
          liveCtx.session = {
            ...readySession,
            status: "ready",
            updatedAt,
          };
          liveCtx.lastPromptSettledAtMillis = yield* Clock.currentTimeMillis;
          if (options?.emitTurnCompletion === false || !canEmitTurnCompletion) {
            return;
          }
          if (activeTurnId !== undefined) {
            yield* emitTerminalEvent(activeTurnId);
          }
          return;
        }

        if (
          !devinPromptSettlementBelongsToContext({
            liveAcpSessionId: liveCtx.acpSessionId,
            expectedAcpSessionId,
            inFlightTurnIds: liveCtx.inFlightTurnIds,
            turnId,
          })
        ) {
          // Late settlement for an interrupted or already-settled prompt: it
          // must neither emit a second terminal event nor disturb the queue.
          return;
        }
        liveCtx.inFlightTurnIds = liveCtx.inFlightTurnIds.filter((id) => id !== turnId);

        if (liveCtx.inFlightTurnIds.length === 0) {
          const updatedAt = yield* nowIso;
          const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
          liveCtx.activeTurnId = undefined;
          liveCtx.session = {
            ...readySession,
            status: "ready",
            updatedAt,
          };
          liveCtx.lastPromptSettledAtMillis = yield* Clock.currentTimeMillis;
        }
        if (options?.emitTurnCompletion === false) {
          return;
        }
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" ||
          liveCtx.session.status === "connecting" ||
          liveCtx.session.status === "ready";
        // Every started turn gets exactly one terminal event. For a turn
        // superseded by a steer, ingestion rejects the lifecycle change (it is
        // not the active turn), so this cannot flip the session ready early.
        if (canEmitTurnCompletion) {
          yield* emitTerminalEvent(turnId);
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload: summarizeAcpNativePayload(payload),
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Devin notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: DevinSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DevinSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: DevinSessionContext, emitExit = true) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        if (emitExit) {
          ownedThreadIds.delete(ctx.threadId);
          yield* offerRuntimeEvent({
            type: "session.exited",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            payload: { exitKind: "graceful" },
          });
        }
      });

    const startSessionUnlocked = (input: Parameters<DevinAdapterShape["startSession"]>[0]) =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          if (yield* Ref.get(stoppingAllRef)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: "Devin adapter is stopping all sessions.",
            });
          }
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const devinModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const requestedStartModelId = devinModelSelection?.model
            ? resolveDevinAcpBaseModelId(devinModelSelection.model)
            : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const promptConfigurationSemaphore = yield* Semaphore.make(1);
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseDevinResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeDevinAcpRuntime({
            devinSettings,
            ...(requestedStartModelId ? { model: requestedStartModelId } : {}),
            ...(options?.environment ? { environment: options.environment } : {}),
            ...(options?.authenticationTimeout
              ? { authenticationTimeout: options.authenticationTimeout }
              : {}),
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            const handleAcpFormRequest = Effect.fn("handleAcpFormRequest")(function* (
              request: AcpFormRequest,
              method: string,
            ) {
              yield* logNative(input.threadId, method, request);
              const normalized = mapAcpFormToUserInput(request);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const resolution = yield* Deferred.make<PendingUserInputResolution>();
              const completed = yield* Deferred.make<void>();
              const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
              pendingUserInputs.set(requestId, { request, resolution, completed, claimed: false });
              return yield* Effect.gen(function* () {
                yield* offerRuntimeEvent({
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: {
                    message: normalized.message,
                    questions: normalized.questions,
                    responseActions: ["decline", "cancel"],
                    requiresReview: true,
                  },
                  raw: {
                    source: "acp.jsonrpc",
                    method,
                    payload: request,
                  },
                });
                const resolved = yield* Deferred.await(resolution);
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: {
                    action: resolved.action,
                    answers: resolved.answers,
                  },
                });
                return resolved;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => pendingUserInputs.delete(requestId)).pipe(
                    Effect.andThen(Deferred.succeed(completed, undefined).pipe(Effect.ignore)),
                  ),
                ),
              );
            });

            yield* acp.handleExtRequest(
              "elicitation/create",
              CurrentAcpElicitationCreateRequest,
              (request) => {
                if (!isCurrentFormRequest(request)) {
                  return Effect.fail(
                    EffectAcpErrors.AcpRequestError.invalidParams(
                      "T3 Code supports form elicitation only.",
                    ),
                  );
                }
                const ctx = sessions.get(input.threadId);
                if (!ctx || ("sessionId" in request && request.sessionId !== ctx.acpSessionId)) {
                  return Effect.fail(
                    EffectAcpErrors.AcpRequestError.invalidParams(
                      "Elicitation session does not match the active Devin session.",
                    ),
                  );
                }
                return mapAcpCallbackFailure(
                  handleAcpFormRequest(request, "elicitation/create"),
                ).pipe(
                  Effect.map((resolved) =>
                    makeCurrentAcpElicitationResponse(
                      resolved.action,
                      resolved.action === "accept" ? resolved.content : {},
                    ),
                  ),
                );
              },
            );
            yield* acp.handleElicitation((request) => {
              if (request.mode !== "form") {
                return Effect.fail(
                  EffectAcpErrors.AcpRequestError.invalidParams(
                    "T3 Code supports form elicitation only.",
                  ),
                );
              }
              const ctx = sessions.get(input.threadId);
              if (!ctx || request.sessionId !== ctx.acpSessionId) {
                return Effect.fail(
                  EffectAcpErrors.AcpRequestError.invalidParams(
                    "Elicitation session does not match the active Devin session.",
                  ),
                );
              }
              return mapAcpCallbackFailure(
                handleAcpFormRequest(request, "session/elicitation"),
              ).pipe(
                Effect.map((resolved) =>
                  makeLegacyAcpElicitationResponse(
                    resolved.action,
                    resolved.action === "accept" ? resolved.content : {},
                  ),
                ),
              );
            });
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            // Devin leans heavily on vendor extensions (`cognition.ai/*`).
            // Unrecognised ones are still refused with methodNotFound, exactly
            // as the protocol does by default — but they are recorded first, so
            // extension traffic this adapter does not implement is visible when
            // diagnosing a session instead of vanishing.
            yield* acp.handleUnknownExtRequest((method, params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, method, params);
                return yield* EffectAcpErrors.AcpRequestError.methodNotFound(method);
              }),
            );
            yield* acp.handleUnknownExtNotification((method, params) =>
              logNative(input.threadId, method, params),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const negotiatedModelId = yield* applyDevinAcpModelSelection({
            runtime: acp,
            currentModelId: currentDevinModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });
          const boundModelId = negotiatedModelId ?? requestedStartModelId;

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveDevinAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DEVIN_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: DevinSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            runtimeMode: input.runtimeMode,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            toolTurnIds: new Map(),
            promptConfigurationSemaphore,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            inFlightTurnIds: [],
            currentModelId: boundModelId,
            lastTokenUsage: undefined,
            lastPromptSettledAtMillis: yield* Clock.currentTimeMillis,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "UsageUpdated" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged") {
                  return;
                }

                if (event._tag === "AvailableCommandsUpdated") {
                  yield* options?.onSlashCommandsChanged?.(event.commands) ?? Effect.void;
                  return;
                }

                const activeNotificationTurnId = resolveNotificationTurnId(ctx);
                if (event._tag === "UsageUpdated") {
                  yield* emitTokenUsage(
                    ctx,
                    activeNotificationTurnId,
                    normalizeAcpUsageUpdate(event.usage, ctx.lastTokenUsage),
                  );
                  return;
                }

                const notificationTurnId =
                  event._tag === "ToolCallUpdated"
                    ? (activeNotificationTurnId ?? ctx.toolTurnIds.get(event.toolCall.toolCallId))
                    : activeNotificationTurnId;
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                const stamp = yield* makeEventStamp();

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                        streamKind: event.streamKind,
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                        streamKind: event.streamKind,
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    if (
                      event.toolCall.status === "completed" ||
                      event.toolCall.status === "failed"
                    ) {
                      ctx.toolTurnIds.delete(event.toolCall.toolCallId);
                    } else {
                      ctx.toolTurnIds.set(event.toolCall.toolCallId, notificationTurnId);
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        streamKind: event.streamKind,
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Devin runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          ownedThreadIds.add(input.threadId);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Devin ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const startSession: DevinAdapterShape["startSession"] = (input) =>
      Effect.flatMap(getThreadSemaphore(input.threadId), (semaphore) =>
        Effect.sync(() => ownedThreadIds.add(input.threadId)).pipe(
          Effect.andThen(semaphore.withPermit(startSessionUnlocked(input))),
          Effect.onError(() =>
            Effect.sync(() => {
              if (!sessions.has(input.threadId)) {
                ownedThreadIds.delete(input.threadId);
              }
            }),
          ),
        ),
      );

    const shouldProbeIdleSession = Effect.fn("shouldProbeIdleDevinSession")(function* (
      ctx: DevinSessionContext,
    ) {
      if (ctx.inFlightTurnIds.length > 0) {
        return false;
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      return nowMillis - ctx.lastPromptSettledAtMillis >= Duration.toMillis(idleLivenessProbeAfter);
    });

    const probeIdleSession = Effect.fn("probeIdleDevinSession")(function* (
      ctx: DevinSessionContext,
    ) {
      const result = yield* ctx.acp.request("session/list", { cwd: ctx.session.cwd }).pipe(
        Effect.match({
          onFailure: (error) => error._tag === "AcpRequestError",
          onSuccess: () => true,
        }),
        Effect.timeoutOption(idleLivenessProbeTimeout),
      );
      return Option.getOrElse(result, () => false);
    });

    const restartIdleSession = Effect.fn("restartIdleDevinSession")(function* (
      ctx: DevinSessionContext,
    ) {
      const restartInput: Parameters<DevinAdapterShape["startSession"]>[0] = {
        threadId: ctx.threadId,
        provider: PROVIDER,
        cwd: ctx.session.cwd,
        resumeCursor: ctx.session.resumeCursor,
        runtimeMode: ctx.runtimeMode,
        ...(ctx.session.model
          ? {
              modelSelection: {
                instanceId: boundInstanceId,
                model: ctx.session.model,
              },
            }
          : {}),
      };
      if (yield* Ref.get(stoppingAllRef)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/start",
          detail: "Devin adapter is stopping all sessions.",
        });
      }
      yield* stopSessionInternal(ctx, false);
      yield* startSessionUnlocked(restartInput).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const stoppingAll = yield* Ref.get(stoppingAllRef);
            ownedThreadIds.delete(ctx.threadId);
            yield* offerRuntimeEvent({
              type: "session.exited",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: stoppingAll
                ? { exitKind: "graceful", reason: "Session stopped." }
                : {
                    exitKind: "error",
                    reason: error.message,
                    recoverable: true,
                  },
            });
          }),
        ),
      );
      return yield* requireSession(ctx.threadId);
    });

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            let ctx = yield* requireSession(input.threadId);
            const shouldProbe = yield* shouldProbeIdleSession(ctx);
            // A sendTurn while a prompt is in flight is a steer. Devin's ACP
            // server serializes session/prompt (the steered prompt only starts
            // once the in-flight one returns), so the steer opens its own new
            // turn at the tail of the queue instead of continuing the active
            // turn — each prompt settles its own turn with its own result.
            const queuedBehind = ctx.inFlightTurnIds.length > 0;
            const turnId = TurnId.make(yield* randomUUIDv4);
            const markTurnPreparing = (target: DevinSessionContext) =>
              Effect.gen(function* () {
                // Enqueue immediately so a superseded in-flight prompt resolving
                // from here on settles its own turn; removed on settlement below.
                target.inFlightTurnIds = [...target.inFlightTurnIds, turnId];
                // Bind the turn id before cooperative yields so interruptTurn can
                // settle this prompt even if stop arrives during preparation.
                target.activeTurnId = turnId;
                target.session = {
                  ...target.session,
                  status: queuedBehind ? "running" : "connecting",
                  activeTurnId: turnId,
                  updatedAt: yield* nowIso,
                };
              });
            yield* markTurnPreparing(ctx);

            if (shouldProbe && !(yield* probeIdleSession(ctx))) {
              const staleCtx = ctx;
              yield* Effect.logWarning("Restarting an unresponsive idle Devin ACP session.", {
                threadId: input.threadId,
                acpSessionId: staleCtx.acpSessionId,
              });
              ctx = yield* restartIdleSession(staleCtx);
              ctx.turns = staleCtx.turns;
              ctx.interruptedTurnIds = new Set(staleCtx.interruptedTurnIds);
              ctx.inFlightTurnIds = [];
              yield* markTurnPreparing(ctx);
            }

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveDevinAcpBaseModelId(turnModelSelection.model)
                : undefined;
              const currentModelId = yield* applyDevinAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });
              const text = input.input?.trim();
              const imagePromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId
                ? resolveDevinAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Devin prompt was interrupted during preparation.",
                });
              }
              if (!queuedBehind) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: displayModel ? { model: displayModel } : {},
              });

              const notificationFiber = ctx.notificationFiber;
              if (!notificationFiber) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/update",
                  detail: "Devin notification consumer was not started.",
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                interactionMode: input.interactionMode,
                notificationFiber,
                promptConfigurationSemaphore: ctx.promptConfigurationSemaphore,
                promptParts,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Devin prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          const result = yield* prepared.promptConfigurationSemaphore
            .withPermits(1)(
              Effect.gen(function* () {
                const liveCtx = sessions.get(input.threadId);
                if (!liveCtx || liveCtx.acpSessionId !== prepared.acpSessionId) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: "Devin session changed before wire dispatch.",
                  });
                }
                if (liveCtx.interruptedTurnIds.has(prepared.turnId)) {
                  return { stopReason: "cancelled" } satisfies EffectAcpSchema.PromptResponse;
                }
                yield* applyDevinAcpInteractionMode({
                  runtime: prepared.acp,
                  interactionMode: prepared.interactionMode,
                  runtimeMode: liveCtx.runtimeMode,
                  mapError: (cause) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      input.threadId,
                      "session/set_config_option",
                      cause,
                    ),
                });
                return yield* prepared.acp
                  .prompt({
                    prompt: prepared.promptParts,
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                    ),
                  );
              }),
            )
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(promptFailureMessageRef, error.message).pipe(
                  Effect.andThen(
                    drainDevinAcpEvents({
                      threadId: input.threadId,
                      acp: prepared.acp,
                      notificationFiber: prepared.notificationFiber,
                    }),
                  ),
                ),
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Devin session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Devin session changed before the turn completed.",
                });
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* drainDevinAcpEvents({
                threadId: input.threadId,
                acp: prepared.acp,
                notificationFiber: prepared.notificationFiber,
              });
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (!ctx.inFlightTurnIds.includes(prepared.turnId)) {
                // interruptTurn already consumed this turn's queue slot. A late
                // prompt result must neither emit a second terminal event nor
                // disturb turns queued behind it.
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              if (result.usage) {
                yield* emitTokenUsage(
                  ctx,
                  prepared.turnId,
                  normalizeAcpPromptUsage(result.usage, ctx.lastTokenUsage),
                );
              }
              ctx.inFlightTurnIds = ctx.inFlightTurnIds.filter((id) => id !== prepared.turnId);
              const completedStopReason = completedStopReasonFromPromptResponse(result);
              // Each prompt settles its own turn. When turns are queued behind
              // it (steers), the session keeps running on the newest turn;
              // ingestion rejects lifecycle changes from a non-active turn, so
              // completing turn N here cannot flip the session ready while
              // turn N+1 is still in flight.
              if (ctx.inFlightTurnIds.length === 0) {
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                ctx.lastPromptSettledAtMillis = yield* Clock.currentTimeMillis;
              } else {
                ctx.session = {
                  ...ctx.session,
                  status: "running",
                  updatedAt: yield* nowIso,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
              }
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload: {
                  state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: completedStopReason,
                },
              });
              ctx.interruptedTurnIds.delete(prepared.turnId);
              yield* Ref.set(promptSettled, true);

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Devin session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (!ctx.inFlightTurnIds.includes(prepared.turnId)) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "Devin prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: DevinAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          // Stop drops the whole queue: turns superseded by a steer are already
          // settled in the projector, but their prompts may still resolve
          // wire-side and must not resurrect.
          for (const inFlightTurnId of ctx.inFlightTurnIds) {
            ctx.interruptedTurnIds.add(inFlightTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (
              observed.acpSessionId !== undefined &&
              ctx.acpSessionId !== observed.acpSessionId &&
              (observed.interruptedTurnId === undefined ||
                activeTurnId !== observed.interruptedTurnId)
            ) {
              return;
            }
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              for (const inFlightTurnId of ctx.inFlightTurnIds) {
                ctx.interruptedTurnIds.add(inFlightTurnId);
              }
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.inFlightTurnIds.length > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.inFlightTurnIds = [];
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: DevinAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: DevinAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
      action = "accept",
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "elicitation/create",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        const resolved: PendingUserInputResolution =
          action === "accept"
            ? {
                action,
                answers,
                content: yield* normalizeAcpFormAnswers(pending.request, answers),
              }
            : { action, answers: {} };
        if (pending.claimed) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "elicitation/create",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        pending.claimed = true;
        yield* Deferred.succeed(pending.resolution, resolved);
        yield* Deferred.await(pending.completed);
      });

    const readThread: DevinAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: DevinAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Devin ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: DevinAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DevinAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: DevinAdapterShape["hasSession"] = (threadId) =>
      Effect.gen(function* () {
        if (!ownedThreadIds.has(threadId)) {
          return false;
        }
        const semaphore = (yield* SynchronizedRef.get(threadLocksRef)).get(threadId);
        if (!semaphore) {
          return false;
        }
        return yield* semaphore.withPermit(
          Effect.sync(() => {
            const c = sessions.get(threadId);
            return c !== undefined && !c.stopped;
          }),
        );
      });

    const stopAll: DevinAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        yield* Ref.set(stoppingAllRef, true);
        const threadIds = Array.from(ownedThreadIds);
        yield* Effect.forEach(
          threadIds,
          (threadId) =>
            withThreadLock(
              threadId,
              Effect.gen(function* () {
                const ctx = sessions.get(threadId);
                if (ctx) {
                  yield* stopSessionInternal(ctx);
                }
              }),
            ),
          { discard: true },
        );
      }).pipe(Effect.ensuring(Ref.set(stoppingAllRef, false)));

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        userInputActions: ["accept", "decline", "cancel"],
        conversationRollback: "unsupported",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DevinAdapterShape;
  });
}
