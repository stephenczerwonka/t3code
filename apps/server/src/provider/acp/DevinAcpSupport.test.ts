import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDevinAcpInteractionMode,
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  DEVIN_ACP_CLIENT_CAPABILITIES,
  hasDevinCredentials,
  resolveDevinAuthMethod,
  resolveDevinAcpBaseModelId,
  resolveDevinAcpInteractionMode,
  resolveDevinPermissionMode,
  resolveDevinPromptIdleTimeout,
} from "./DevinAcpSupport.ts";

describe("DEVIN_ACP_CLIENT_CAPABILITIES", () => {
  it("advertises form elicitation without URL, filesystem, or terminal support", () => {
    expect(DEVIN_ACP_CLIENT_CAPABILITIES).toEqual({
      elicitation: { form: {} },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });
});

describe("resolveDevinPromptIdleTimeout", () => {
  it("defaults to one hour and honors an explicit override", () => {
    expect(resolveDevinPromptIdleTimeout(undefined)).toEqual(Duration.minutes(60));
    expect(resolveDevinPromptIdleTimeout("30 seconds")).toBe("30 seconds");
  });
});

describe("resolveDevinAcpBaseModelId", () => {
  it("normalizes empty and custom Devin model ids", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("   ")).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("  swe-1-6-fast  ")).toBe("swe-1-6-fast");
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("spawns `devin acp` with the configured binary and environment", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/usr/local/bin/devin", apiKey: "" },
      "/tmp/project",
      { WINDSURF_API_KEY: "secret" },
      "claude-sonnet-5-high",
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp", "--model", "claude-sonnet-5-high"],
      cwd: "/tmp/project",
      env: { WINDSURF_API_KEY: "secret" },
    });
  });

  it("falls back to the `devin` binary when no path is configured", () => {
    const spawn = buildDevinAcpSpawnInput(null, "/tmp/project");
    expect(spawn.command).toBe("devin");
    expect(spawn.args).toEqual(["acp"]);
  });

  it("starts Devin in the native permission mode matching T3", () => {
    const spawn = buildDevinAcpSpawnInput(
      null,
      "/tmp/project",
      { EXISTING: "value", DEVIN_PERMISSION_MODE: "auto" },
      undefined,
      "full-access",
    );
    expect(spawn.env).toEqual({
      EXISTING: "value",
      DEVIN_PERMISSION_MODE: "dangerous",
    });
  });
});

describe("hasDevinCredentials", () => {
  it("prefers the settings API key, then the environment variable", () => {
    expect(hasDevinCredentials({ apiKey: "key" }, {})).toBe(true);
    expect(hasDevinCredentials({ apiKey: "" }, { WINDSURF_API_KEY: "key" })).toBe(true);
    expect(hasDevinCredentials({ apiKey: "  " }, { WINDSURF_API_KEY: "  " })).toBe(false);
    expect(hasDevinCredentials(null, undefined)).toBe(false);
  });
});

describe("resolveDevinPermissionMode", () => {
  it("maps T3 runtime modes to native Devin permission modes", () => {
    expect(resolveDevinPermissionMode("approval-required")).toBe("auto");
    expect(resolveDevinPermissionMode("auto-accept-edits")).toBe("accept-edits");
    expect(resolveDevinPermissionMode("auto")).toBe("smart");
    expect(resolveDevinPermissionMode("full-access")).toBe("dangerous");
  });
});

describe("Devin ACP interaction mode", () => {
  const modeConfig = (
    currentValue: string,
    values: ReadonlyArray<string>,
  ): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    },
  ];

  it("resolves plan and default aliases from the negotiated mode config", () => {
    const configOptions = modeConfig("ask", ["ask", "architect", "code"]);
    expect(resolveDevinAcpInteractionMode({ configOptions, interactionMode: "plan" })).toEqual({
      configId: "mode",
      currentValue: "ask",
      value: "architect",
    });
    expect(resolveDevinAcpInteractionMode({ configOptions, interactionMode: "default" })).toEqual({
      configId: "mode",
      currentValue: "ask",
      value: "code",
    });
    expect(
      resolveDevinAcpInteractionMode({
        configOptions: modeConfig("normal", ["normal", "plan", "ask"]),
        interactionMode: "default",
      }),
    ).toEqual({ configId: "mode", currentValue: "normal", value: "normal" });
  });

  it("does not guess when the provider omits a compatible mode", () => {
    expect(
      resolveDevinAcpInteractionMode({
        configOptions: modeConfig("ask", ["ask", "review"]),
        interactionMode: "plan",
      }),
    ).toBeUndefined();
    expect(
      resolveDevinAcpInteractionMode({ configOptions: [], interactionMode: "plan" }),
    ).toBeUndefined();
  });

  it.effect("writes only actual negotiated mode changes", () =>
    Effect.gen(function* () {
      let currentValue = "normal";
      const calls: Array<[string, string | boolean]> = [];
      const runtime = {
        getConfigOptions: Effect.sync(() => modeConfig(currentValue, ["normal", "plan", "ask"])),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([configId, value]);
            if (typeof value === "string") currentValue = value;
            return { configOptions: modeConfig(currentValue, ["normal", "plan", "ask"]) };
          }),
      };

      expect(
        yield* applyDevinAcpInteractionMode({
          runtime,
          interactionMode: "plan",
          mapError: (cause: EffectAcpErrors.AcpError) => cause,
        }),
      ).toBe(true);
      expect(
        yield* applyDevinAcpInteractionMode({
          runtime,
          interactionMode: "plan",
          mapError: (cause: EffectAcpErrors.AcpError) => cause,
        }),
      ).toBe(false);
      expect(
        yield* applyDevinAcpInteractionMode({
          runtime,
          interactionMode: "default",
          mapError: (cause: EffectAcpErrors.AcpError) => cause,
        }),
      ).toBe(true);
      expect(calls).toEqual([
        ["mode", "plan"],
        ["mode", "normal"],
      ]);
    }),
  );
});

describe("resolveDevinAuthMethod", () => {
  it("prefers the current browser method and supports the legacy API-key method", () => {
    expect(
      resolveDevinAuthMethod({
        authMethods: [{ id: "devin-browser", name: "Log in with browser" }],
      }),
    ).toBe("devin-browser");
    expect(
      resolveDevinAuthMethod({
        authMethods: [{ id: "windsurf-api-key", name: "Windsurf API key" }],
      }),
    ).toBe("windsurf-api-key");
    expect(resolveDevinAuthMethod({ authMethods: [] })).toBe("devin-browser");
  });
});

describe("applyDevinAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the agent reported a differing current model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "swe-1-6-fast",
        mapError: (cause: EffectAcpErrors.AcpError) => cause.message,
      });
      expect(modelCalls).toEqual(["swe-1-6-fast"]);
      expect(result).toBe("swe-1-6-fast");
    }),
  );

  it.effect("skips set_model when the agent reported no model state", () =>
    Effect.gen(function* () {
      // Devin's ACP server routes models server-side (Adaptive) and does not
      // negotiate a session model — never call the unstable method then.
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "adaptive",
        mapError: (cause: EffectAcpErrors.AcpError) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "adaptive",
        mapError: (cause: EffectAcpErrors.AcpError) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("keeps the agent default when set_model is unimplemented", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.methodNotFound("session/set_model");
      const { runtime } = makeRecordingRuntime(failure);
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "swe-1-6-fast",
        mapError: (cause: EffectAcpErrors.AcpError) => cause.message,
      });
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("propagates other session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          currentModelId: "adaptive",
          requestedModelId: "swe-1-6-fast",
          mapError: (cause: EffectAcpErrors.AcpError) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
