/**
 * Optional integration checks against a real `devin acp` install.
 *
 * Core lifecycle:
 *   T3_DEVIN_ACP_PROBE=1 vp test run apps/server/src/provider/acp/DevinAcpCliProbe.test.ts
 * Stored CLI credentials only:
 *   T3_DEVIN_ACP_STORED_AUTH_PROBE=1 vp test run apps/server/src/provider/acp/DevinAcpCliProbe.test.ts
 * Runtime ACP credentials:
 *   T3_DEVIN_ACP_RUNTIME_API_KEY=... T3_DEVIN_ACP_PROBE=1 vp test run apps/server/src/provider/acp/DevinAcpCliProbe.test.ts
 *
 * These checks require network access and may consume Devin credits. Browser
 * authentication is deliberately not automated; run `devin auth login` first.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";

import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import { makeDevinAcpRuntime } from "./DevinAcpSupport.ts";

const PROBE_TIMEOUT = "90 seconds";
const FIRST_SENTINEL = "T3_DEVIN_ACP_OK";
const RESUME_SENTINEL = "T3_DEVIN_ACP_RESUME_OK";

type ProbeAuth = "default" | "stored" | "runtime";

function probeEnvironment(auth: ProbeAuth): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.T3_DEVIN_ACP_PROBE;
  delete environment.T3_DEVIN_ACP_STORED_AUTH_PROBE;
  delete environment.T3_DEVIN_ACP_RUNTIME_API_KEY;
  if (auth === "stored" || auth === "runtime") {
    delete environment.WINDSURF_API_KEY;
  }
  return environment;
}

const makeProbeRuntime = (input: { readonly auth: ProbeAuth; readonly resumeSessionId?: string }) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeApiKey = process.env.T3_DEVIN_ACP_RUNTIME_API_KEY?.trim();
    return yield* makeDevinAcpRuntime({
      devinSettings: {
        binaryPath: process.env.T3_DEVIN_BINARY?.trim() || "devin",
        apiKey: input.auth === "runtime" ? (runtimeApiKey ?? "") : "",
      },
      environment: probeEnvironment(input.auth),
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-devin-probe", version: "0.0.0" },
      authenticationTimeout: "30 seconds",
      promptIdleTimeout: "2 minutes",
      toolCallIdleTimeout: "2 minutes",
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    });
  });

const startProbe = (auth: ProbeAuth, resumeSessionId?: string) =>
  Effect.gen(function* () {
    const runtime = yield* makeProbeRuntime({
      auth,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    const started = yield* runtime.start();
    return { runtime, started };
  });

const runSentinelPrompt = (runtime: AcpSessionRuntime["Service"], sentinel: string) =>
  Effect.gen(function* () {
    let assistantText = "";
    const eventTags: Array<string> = [];
    const eventConsumer = yield* Stream.runForEach(runtime.getEvents(), (event) => {
      if (event._tag === "EventStreamBarrier") {
        return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
      }
      return Effect.sync(() => {
        eventTags.push(event._tag);
        if (event._tag === "ContentDelta" && event.streamKind === "assistant_text") {
          assistantText += event.text;
        }
      });
    }).pipe(Effect.forkChild({ startImmediately: true }));

    const result = yield* runtime.prompt({
      prompt: [
        {
          type: "text",
          text: `Reply with exactly ${sentinel}. Do not use tools or modify files.`,
        },
      ],
    });
    yield* runtime.drainEvents;
    yield* Fiber.interrupt(eventConsumer);

    expect(result.stopReason).not.toBe("cancelled");
    expect(eventTags).toContain("ContentDelta");
    expect(assistantText).toContain(sentinel);
    return result;
  });

function findModeOption(configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) {
  return configOptions.find(
    (option) => option.type === "select" && (option.id === "mode" || option.category === "mode"),
  );
}

const verifyNegotiatedPlanMode = (runtime: AcpSessionRuntime["Service"]) =>
  Effect.gen(function* () {
    const before = yield* runtime.getConfigOptions;
    const mode = findModeOption(before);
    if (!mode || mode.type !== "select") return;

    const originalValue = mode.currentValue;
    const planValue = collectSessionConfigOptionValues(mode).find((value) =>
      /^(plan|architect)$/iu.test(value.trim()),
    );
    if (!planValue || planValue === originalValue) return;

    yield* runtime.setConfigOption(mode.id, planValue);
    const selected = findModeOption(yield* runtime.getConfigOptions);
    expect(selected?.currentValue).toBe(planValue);
    yield* runtime.setConfigOption(mode.id, originalValue);
    const restored = findModeOption(yield* runtime.getConfigOptions);
    expect(restored?.currentValue).toBe(originalValue);
  });

describe.runIf(process.env.T3_DEVIN_ACP_STORED_AUTH_PROBE === "1")(
  "Devin ACP stored-credential probe",
  () => {
    it.effect("starts with credentials from `devin auth login` and no API-key environment", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { started } = yield* startProbe("stored");
          expect(started.sessionId.trim()).not.toBe("");
          expect(started.initializeResult.authMethods?.length ?? 0).toBeGreaterThan(0);
        }),
      ).pipe(Effect.timeout(PROBE_TIMEOUT), Effect.provide(NodeServices.layer)),
    );
  },
);

describe.runIf(
  process.env.T3_DEVIN_ACP_PROBE === "1" && Boolean(process.env.WINDSURF_API_KEY?.trim()),
)("Devin ACP environment-credential probe", () => {
  it.effect("starts with WINDSURF_API_KEY inherited by the child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started } = yield* startProbe("default");
        expect(started.sessionId.trim()).not.toBe("");
      }),
    ).pipe(Effect.timeout(PROBE_TIMEOUT), Effect.provide(NodeServices.layer)),
  );
});

describe.runIf(
  process.env.T3_DEVIN_ACP_PROBE === "1" &&
    Boolean(process.env.T3_DEVIN_ACP_RUNTIME_API_KEY?.trim()),
)("Devin ACP runtime-credential probe", () => {
  it.effect("starts with an API key supplied through ACP authenticate metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started } = yield* startProbe("runtime");
        expect(started.sessionId.trim()).not.toBe("");
      }),
    ).pipe(Effect.timeout(PROBE_TIMEOUT), Effect.provide(NodeServices.layer)),
  );
});

describe.runIf(process.env.T3_DEVIN_ACP_PROBE === "1")("Devin ACP CLI probe", () => {
  it.effect("creates, prompts, negotiates Plan mode, resumes, and prompts again", () =>
    Effect.gen(function* () {
      const sessionId = yield* Effect.scoped(
        Effect.gen(function* () {
          const { runtime, started } = yield* startProbe("default");
          expect(started.sessionId.trim()).not.toBe("");
          expect(started.initializeResult).toBeDefined();
          yield* runSentinelPrompt(runtime, FIRST_SENTINEL);
          yield* verifyNegotiatedPlanMode(runtime);
          return started.sessionId;
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { runtime, started } = yield* startProbe("default", sessionId);
          expect(started.sessionId).toBe(sessionId);
          yield* runSentinelPrompt(runtime, RESUME_SENTINEL);
        }),
      );
    }).pipe(Effect.timeout(PROBE_TIMEOUT), Effect.provide(NodeServices.layer)),
  );
});
