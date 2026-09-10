/**
 * Optional integration check through T3's complete Devin adapter.
 * Enable with:
 *   T3_DEVIN_ACP_ADAPTER_PROBE=1 vp test run apps/server/src/provider/Layers/DevinAdapterCliProbe.test.ts
 *
 * This check requires network access and may consume Devin credits. Browser
 * authentication is deliberately not automated; run `devin auth login` first.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  DevinSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const SENTINEL = "T3_DEVIN_ADAPTER_OK";

const adapterProbeLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-probe-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe.runIf(process.env.T3_DEVIN_ACP_ADAPTER_PROBE === "1")("Devin adapter CLI probe", () => {
  it.effect("maps a real Devin ACP prompt to T3 runtime events", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const threadId = ThreadId.make(`devin-adapter-probe-${yield* crypto.randomUUIDv4}`);
      const adapter = yield* makeDevinAdapter(
        decodeDevinSettings({
          binaryPath: process.env.T3_DEVIN_BINARY?.trim() || "devin",
        }),
        { environment: process.env },
      );
      yield* Effect.addFinalizer(() => adapter.stopSession(threadId).pipe(Effect.ignore));

      const events: Array<ProviderRuntimeEvent> = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventConsumer = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      expect(session.provider).toBe("devin");
      expect(session.resumeCursor).toBeDefined();

      yield* adapter.sendTurn({
        threadId,
        input: `Reply with exactly ${SENTINEL}. Do not use tools or modify files.`,
        attachments: [],
      });
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventConsumer);

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toContain("session.started");
      expect(eventTypes).toContain("turn.started");
      expect(eventTypes).toContain("content.delta");
      expect(eventTypes).toContain("turn.completed");
      const assistantText = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta)
        .join("");
      expect(assistantText).toContain(SENTINEL);
    }).pipe(Effect.scoped, Effect.timeout("90 seconds"), Effect.provide(adapterProbeLayer)),
  );
});
