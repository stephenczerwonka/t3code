// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  devinPromptSettlementBelongsToContext,
  makeDevinAdapter,
  selectAutoApprovedPermissionOption,
  selectPermissionOptionId,
} from "./DevinAdapter.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockDevinWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  if (process.platform === "win32") {
    const wrapperPath = NodePath.join(dir, "fake-devin.cmd");
    const envLines = Object.entries(extraEnv ?? {})
      .map(([key, value]) => `set "${key}=${value}"`)
      .join("\r\n");
    const script = `@echo off\r\n${envLines ? `${envLines}\r\n` : ""}${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} %*\r\n`;
    await NodeFSP.writeFile(wrapperPath, script, "utf8");
    return wrapperPath;
  }
  const wrapperPath = NodePath.join(dir, "fake-devin.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDevinAdapter>[1]) =>
  makeDevinAdapter(decodeDevinSettings({ binaryPath }), options).pipe(Effect.orDie);

it("requires a settlement to match the live Devin turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    devinPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      inFlightTurnIds: [replacementTurnId],
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    devinPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      inFlightTurnIds: [staleTurnId],
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    devinPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      inFlightTurnIds: [staleTurnId],
      turnId: staleTurnId,
    }),
  );
});

const devinPermissionRequest = (
  options: ReadonlyArray<{ kind: string; name: string; optionId: string }>,
) =>
  ({
    sessionId: "military-hill",
    options,
    toolCall: { toolCallId: "call-1" },
  }) as unknown as Parameters<typeof selectAutoApprovedPermissionOption>[0];

// Option set taken verbatim from a live Devin `session/request_permission`.
const DEVIN_PERMISSION_OPTIONS = [
  { kind: "allow_once", name: "Allow", optionId: "allow_once" },
  {
    kind: "allow_always",
    name: "Yes, allow `git status` commands (this session)",
    optionId: "allow_session",
  },
  {
    kind: "allow_always",
    name: "Yes, always allow in `web-frontend-angularjs`",
    optionId: "allow_always",
  },
  {
    kind: "allow_always",
    name: "Yes, always allow in all projects",
    optionId: "allow_always_global",
  },
  { kind: "allow_always", name: "Yes, switch to bypass mode", optionId: "switch_bypass" },
  { kind: "reject_once", name: "Reject", optionId: "reject_once" },
];

it("prefers the session-scoped option over broader Devin permission grants", () => {
  const request = devinPermissionRequest(DEVIN_PERMISSION_OPTIONS);

  assert.equal(selectAutoApprovedPermissionOption(request), "allow_session");
  assert.equal(selectPermissionOptionId(request, "acceptForSession"), "allow_session");
});

it("does not let Devin's option ordering select bypass mode", () => {
  const request = devinPermissionRequest(DEVIN_PERMISSION_OPTIONS.toReversed());

  assert.equal(selectAutoApprovedPermissionOption(request), "allow_session");
  assert.notEqual(selectPermissionOptionId(request, "acceptForSession"), "switch_bypass");
});

it("falls back to a single-turn allowance when every persistent option escalates", () => {
  const request = devinPermissionRequest([
    { kind: "allow_always", name: "Yes, switch to bypass mode", optionId: "switch_bypass" },
    {
      kind: "allow_always",
      name: "Yes, always allow in all projects",
      optionId: "allow_always_global",
    },
    { kind: "allow_once", name: "Allow", optionId: "allow_once" },
    { kind: "reject_once", name: "Reject", optionId: "reject_once" },
  ]);

  assert.isUndefined(selectPermissionOptionId(request, "acceptForSession"));
  assert.equal(selectAutoApprovedPermissionOption(request), "allow_once");
});

it.layer(devinAdapterTestLayer)("DevinAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-mock-alt" },
      });

      assert.equal(session.provider, "devin");
      assert.equal(session.model, "devin-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello devin",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restarts an idle Devin session that stops answering ACP requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-idle-liveness-restart");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-idle-liveness-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const markerPath = NodePath.join(tempDir, "hang-list-after-prompt.marker");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_NEXT_LIST_TRIGGER_PATH: markerPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        idleLivenessProbeAfter: "1 second",
        idleLivenessProbeTimeout: "200 millis",
      });

      yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("devin"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeout("10 seconds"));
      yield* Effect.promise(() => NodeFSP.writeFile(markerPath, "hang", "utf8"));
      yield* Effect.sleep("1100 millis");
      yield* adapter
        .sendTurn({ threadId, input: "prompt after idle wedge", attachments: [] })
        .pipe(Effect.timeout("10 seconds"));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      const promptIndexes = methods.flatMap((method, index) =>
        method === "session/prompt" ? [index] : [],
      );
      const loadIndex = methods.indexOf("session/load");

      assert.equal(methods.filter((method) => method === "initialize").length, 2);
      assert.equal(methods.filter((method) => method === "session/list").length, 1);
      assert.equal(promptIndexes.length, 1);
      assert.equal(methods.filter((method) => method === "session/load").length, 1);
      assert.isBelow(loadIndex, promptIndexes[0] ?? -1);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      assert.equal(session?.model, "grok-build");
      assert.equal(session?.runtimeMode, "full-access");
      assert.deepEqual(session?.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.stopSession(threadId).pipe(Effect.timeout("10 seconds"));
    }).pipe(TestClock.withLive),
  );

  it.effect("merges live and final ACP token usage without duplicate snapshots", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-token-usage");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_EMIT_USAGE: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "report usage", attachments: [] });
      yield* Deferred.await(completed);

      const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");
      assert.lengthOf(usageEvents, 2);
      assert.deepStrictEqual(usageEvents[0]?.payload.usage, {
        usedTokens: 100,
        maxTokens: 200_000,
      });
      assert.deepStrictEqual(usageEvents[1]?.payload.usage, {
        usedTokens: 100,
        maxTokens: 200_000,
        totalProcessedTokens: 420,
        inputTokens: 300,
        outputTokens: 100,
        reasoningOutputTokens: 20,
        cachedInputTokens: 50,
      });
      assert.isBelow(
        events.indexOf(usageEvents[1]!),
        events.findIndex((event) => event.type === "turn.completed"),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("publishes ACP provider command snapshots", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-provider-commands");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_EMIT_AVAILABLE_COMMANDS: "1" }),
      );
      const commands = yield* Deferred.make<ReadonlyArray<ServerProviderSlashCommand>>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        onSlashCommandsChanged: (next) => Deferred.succeed(commands, next).pipe(Effect.asVoid),
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "show commands", attachments: [] });

      assert.deepStrictEqual(yield* Deferred.await(commands), [
        { name: "btw", description: "Ask in the background", input: { hint: "message" } },
        { name: "loop", description: "Run repeatedly" },
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reuses an idle Devin session when its liveness probe responds", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-idle-liveness-healthy");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-idle-healthy-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        idleLivenessProbeAfter: "1 second",
        idleLivenessProbeTimeout: "200 millis",
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Effect.sleep("1100 millis");
      yield* adapter.sendTurn({ threadId, input: "first healthy prompt", attachments: [] });
      yield* Effect.sleep("1100 millis");
      yield* adapter.sendTurn({ threadId, input: "second healthy prompt", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.equal(methods.filter((method) => method === "initialize").length, 1);
      assert.equal(methods.filter((method) => method === "session/list").length, 2);
      assert.equal(methods.filter((method) => method === "session/prompt").length, 2);
      assert.notInclude(methods, "session/load");

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not dispatch a prompt when Stop arrives during a hanging liveness probe", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-idle-liveness-cancel");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-idle-cancel-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const markerPath = NodePath.join(tempDir, "hang-list-after-prompt.marker");
      const hangingListEnteredPath = NodePath.join(tempDir, "hanging-list-entered.marker");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_NEXT_LIST_TRIGGER_PATH: markerPath,
          T3_ACP_HANGING_LIST_ENTERED_PATH: hangingListEnteredPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        idleLivenessProbeAfter: "1 second",
        idleLivenessProbeTimeout: "500 millis",
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => NodeFSP.writeFile(markerPath, "hang", "utf8"));
      yield* Effect.sleep("1100 millis");
      const secondTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before dispatch", attachments: [] })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(hangingListEnteredPath, 80, "entered");
      yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(secondTurnFiber).pipe(Effect.ignore, Effect.timeout("5 seconds"));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptRequests = requests.filter((request) => request.method === "session/prompt");
      assert.equal(promptRequests.length, 0);

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("emits a terminal session event when idle recovery cannot load the session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-idle-liveness-load-failure");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-idle-load-failure-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const markerPath = NodePath.join(tempDir, "hang-list-after-prompt.marker");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_NEXT_LIST_TRIGGER_PATH: markerPath,
          T3_ACP_FAIL_LOAD_SESSION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        idleLivenessProbeAfter: "1 second",
        idleLivenessProbeTimeout: "200 millis",
      });
      const sessionExited =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "session.exited" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "session.exited"
          ? Deferred.succeed(sessionExited, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => NodeFSP.writeFile(markerPath, "hang", "utf8"));
      yield* Effect.sleep("1100 millis");
      yield* adapter
        .sendTurn({ threadId, input: "fail the idle recovery", attachments: [] })
        .pipe(Effect.flip, Effect.timeout("10 seconds"));

      const exited = yield* Deferred.await(sessionExited).pipe(Effect.timeout("2 seconds"));
      assert.equal(exited.payload.exitKind, "error");
      assert.isTrue(exited.payload.recoverable);
      assert.isEmpty(yield* adapter.listSessions());
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(requests.filter((request) => request.method === "session/prompt").length, 0);
      assert.equal(requests.filter((request) => request.method === "session/load").length, 1);

      yield* Fiber.interrupt(eventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not respawn an idle Devin session while stopAll is running", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-idle-liveness-stop-all");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-idle-stop-all-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const markerPath = NodePath.join(tempDir, "hang-list-after-prompt.marker");
      const hangingListEnteredPath = NodePath.join(tempDir, "hanging-list-entered.marker");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_NEXT_LIST_TRIGGER_PATH: markerPath,
          T3_ACP_HANGING_LIST_ENTERED_PATH: hangingListEnteredPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        idleLivenessProbeAfter: "1 second",
        idleLivenessProbeTimeout: "500 millis",
      });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const sessionExited = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "session.exited"
              ? Deferred.succeed(sessionExited, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => NodeFSP.writeFile(markerPath, "hang", "utf8"));
      yield* Effect.sleep("1100 millis");
      const secondTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "do not dispatch after shutdown", attachments: [] })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(hangingListEnteredPath, 80, "entered");
      yield* adapter.stopAll().pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(secondTurnFiber).pipe(Effect.ignore, Effect.timeout("5 seconds"));
      yield* Deferred.await(sessionExited).pipe(Effect.timeout("2 seconds"));

      assert.isEmpty(yield* adapter.listSessions());
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(requests.filter((request) => request.method === "initialize").length, 1);
      assert.equal(requests.filter((request) => request.method === "session/load").length, 0);
      assert.equal(requests.filter((request) => request.method === "session/prompt").length, 0);
      const exitEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
          event.type === "session.exited",
      );
      assert.lengthOf(exitEvents, 1);
      assert.equal(exitEvents[0]?.payload.exitKind, "graceful");

      yield* Fiber.interrupt(eventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("applies negotiated plan and default modes before Devin prompts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-interaction-mode");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mode-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_FORCE_MODE_CONFIG: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan the change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "refine the plan",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "implement the change",
        attachments: [],
        interactionMode: "default",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeValues = requests.flatMap((entry) => {
        if (entry.method !== "session/set_config_option") return [];
        const params = entry.params;
        if (!params || typeof params !== "object") return [];
        const record = params as Record<string, unknown>;
        return record.configId === "mode" && typeof record.value === "string" ? [record.value] : [];
      });
      assert.deepStrictEqual(modeValues, ["architect", "code"]);
      const modeAndPromptSequence = requests.flatMap((entry) => {
        if (entry.method === "session/prompt") return ["prompt"];
        if (entry.method !== "session/set_config_option") return [];
        const params = entry.params;
        if (!params || typeof params !== "object") return [];
        const record = params as Record<string, unknown>;
        return record.configId === "mode" && typeof record.value === "string"
          ? [`mode:${record.value}`]
          : [];
      });
      assert.deepStrictEqual(modeAndPromptSequence, [
        "mode:architect",
        "prompt",
        "prompt",
        "mode:code",
        "prompt",
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles current ACP form elicitation and returns typed answers", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-current-elicitation");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_CURRENT_ELICITATION: "1",
          T3_ACP_EXPECT_ELICITATION_ACTION: "accept",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.message, "Configure the migration.");
      assert.deepStrictEqual(requestedEvent.payload.responseActions, ["decline", "cancel"]);
      assert.isTrue(requestedEvent.payload.requiresReview);
      assert.equal(requestedEvent.payload.questions[0]?.id, "strategy");
      assert.equal(requestedEvent.payload.questions[0]?.options[0]?.label, "Safe");
      assert.equal(requestedEvent.payload.questions[0]?.options[0]?.value, "conservative");
      assert.isFalse(requestedEvent.payload.questions[1]?.required);

      const validationError = yield* Effect.flip(
        adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.make(String(requestedEvent.requestId)),
          { strategy: "unknown" },
          "accept",
        ),
      );
      assert.equal(validationError._tag, "ProviderAdapterValidationError");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { strategy: "conservative" },
        "accept",
      );
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.equal(resolvedEvent.payload.action, "accept");
      assert.deepStrictEqual(resolvedEvent.payload.answers, { strategy: "conservative" });
      yield* Fiber.join(turnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels a pending current ACP form when the turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-current-elicitation-cancel");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_CURRENT_ELICITATION: "1",
          T3_ACP_EXPECT_ELICITATION_ACTION: "cancel",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);
      const requestedEvent = yield* Deferred.await(requested);

      yield* adapter.interruptTurn(threadId, requestedEvent.turnId);
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.equal(resolvedEvent.payload.action, "cancel");
      assert.deepStrictEqual(resolvedEvent.payload.answers, {});
      yield* Fiber.join(turnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      // Windows delivers no POSIX signals: killing the cmd-shim child
      // terminates cmd.exe (TerminateProcess), the node grandchild never runs
      // its SIGTERM handler, and the exit log is never written.
      if (process.platform === "win32") return;
      const threadId = ThreadId.make("devin-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("force kills an ACP child that ignores graceful termination", () =>
    Effect.gen(function* () {
      if (NodeOS.platform() === "win32") return;
      const threadId = ThreadId.make("devin-stop-session-force-kill");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-adapter-force-kill-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
          T3_ACP_IGNORE_SIGTERM: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId).pipe(Effect.timeout("5 seconds"));

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }).pipe(TestClock.withLive),
  );

  it.effect("reports a Devin session running only while the prompt is in flight", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-session-ready-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check lifecycle", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores ready without completing an unstarted turn when preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-preparation-failure-while-connecting");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "prepare invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.isUndefined(turnCompletedEvent);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("lets Stop unblock a fully silent Devin prompt and accept a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-stop-after-full-silence");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not let a cancelled prompt settlement consume the follow-up prompt slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-cancelled-settlement-before-follow-up");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-cancel-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "turn.completed") {
            return;
          }
          const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1);
          if (completedCount === 2) {
            yield* Deferred.succeed(twoTurnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "complete the follow-up", attachments: [] })
        .pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.notEqual(String(followUp.turnId), String(firstTurnId));
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-drop-late-cancelled-notifications");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );
      const lateNativeUpdate = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://devin-cancelled-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("late after cancel")
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout("2 seconds"));
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("settles the in-flight prompt before emitting completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-completion-before-next-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const completedCountRef = yield* Ref.make(0);
      const secondTurnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }

        return Ref.modify(completedCountRef, (count) => {
          const nextCount = count + 1;
          return [nextCount, nextCount] as const;
        }).pipe(
          Effect.flatMap((count) => {
            if (count === 1) {
              return adapter
                .sendTurn({
                  threadId,
                  input: "second turn after completion",
                  attachments: [],
                })
                .pipe(Effect.forkChild, Effect.asVoid);
            }
            if (count === 2) {
              return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        );
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Deferred.await(secondTurnCompleted);

      const completedCount = yield* Ref.get(completedCountRef);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(completedCount, 2);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("opens a new turn for a steer and settles each prompt on its own turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-steer-opens-new-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PROMPT_DELAY_MS: "400",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        idleLivenessProbeAfter: "1 second",
        idleLivenessProbeTimeout: "200 millis",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const startedTurnIds: TurnId[] = [];
      const bothTurnsStarted = yield* Deferred.make<void>();
      const bothTurnsCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "turn.started" && event.turnId !== undefined) {
            startedTurnIds.push(event.turnId);
            if (startedTurnIds.length === 2) {
              yield* Deferred.succeed(bothTurnsStarted, undefined).pipe(Effect.ignore);
            }
          }
          if (
            event.type === "turn.completed" &&
            runtimeEvents.filter(
              (entry) =>
                entry.type === "turn.completed" && String(entry.threadId) === String(threadId),
            ).length === 2
          ) {
            yield* Deferred.succeed(bothTurnsCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* Effect.sleep("1100 millis");
      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "first turn", attachments: [] })
        .pipe(Effect.forkChild);
      // Wait until the first prompt is on the wire, then steer mid-flight.
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
      const secondSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "steer mid-flight", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(bothTurnsStarted).pipe(Effect.timeout("4 seconds"));
      assert.notEqual(String(startedTurnIds[0]), String(startedTurnIds[1]));

      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("4 seconds"));
      yield* Fiber.join(secondSendTurnFiber).pipe(Effect.timeout("4 seconds"));
      yield* Deferred.await(bothTurnsCompleted).pipe(Effect.timeout("4 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(startedTurnIds[0]), "completed"],
          [String(startedTurnIds[1]), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(requests.filter((request) => request.method === "session/list").length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("restores a Devin session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_FAIL_PROMPT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "fail prompt",
          attachments: [],
        }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      assert.equal(failedTurnCompleted?.type, "turn.completed");
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming a Devin session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-empty-turn");

      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "devin-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://devin-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
