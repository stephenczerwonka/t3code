import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";

import {
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  parseDevinModelCatalog,
} from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

/** The POSIX fake is an extensionless sh script; Windows gets an executable .cmd. */
function fakeDevinBinary(shLines: ReadonlyArray<string>, cmdLines: ReadonlyArray<string>) {
  return process.platform === "win32"
    ? { fileName: "devin.cmd", content: `@echo off\r\n${cmdLines.join("\r\n")}\r\n` }
    : { fileName: "devin", content: `#!/bin/sh\n${shLines.join("\n")}\n` };
}

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Devin");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.showInteractionModeToggle).toBe(true);
    }),
  );
});

describe("parseDevinModelCatalog", () => {
  it.effect("maps model variants into selector entries and removes duplicates", () =>
    Effect.gen(function* () {
      const models = yield* parseDevinModelCatalog(
        '{"families":[{"variants":[{"model_uid":"claude-sonnet-5-high","label":"Claude Sonnet 5 High"},{"model_uid":"adaptive","label":"Adaptive"}]},{"variants":[{"model_uid":"claude-sonnet-5-high","label":"Duplicate"}]}]}',
      );

      expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
        { slug: "claude-sonnet-5-high", name: "Claude Sonnet 5 High" },
        { slug: "adaptive", name: "Adaptive" },
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken devin install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-version-" });
          const fake = fakeDevinBinary(
            [`printf "%s\\n" "${secretStderr}" >&2`, "exit 2"],
            [`echo ${secretStderr} 1>&2`, "exit /b 2"],
          );
          const devinPath = path.join(dir, fake.fileName);
          yield* fs.writeFileString(devinPath, fake.content);
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Devin CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("stays selectable when the model catalog is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-nokey-" });
          const fake = fakeDevinBinary(
            ['printf "devin 2026.8.18\\n"', "exit 0"],
            ["echo devin 2026.8.18", "exit /b 0"],
          );
          const devinPath = path.join(dir, fake.fileName);
          yield* fs.writeFileString(devinPath, fake.content);
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            {},
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
      expect(snapshot.message).toContain("could not load its model catalog");
    }),
  );

  it.effect("loads model variants without treating the catalog as authentication proof", () =>
    Effect.gen(function* () {
      const snapshots = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-success-" });
          const fake = fakeDevinBinary(
            [
              'if [ "$1" = "--version" ]; then',
              '  printf "devin 2026.8.18\\n"',
              "else",
              `  printf '%s\\n' '{"families":[{"variants":[{"model_uid":"claude-sonnet-5-high","label":"Claude Sonnet 5 High"}]}]}'`,
              "fi",
              "exit 0",
            ],
            [
              'if "%~1"=="--version" (',
              "  echo devin 2026.8.18",
              ") else (",
              '  echo {"families":[{"variants":[{"model_uid":"claude-sonnet-5-high","label":"Claude Sonnet 5 High"}]}]}',
              ")",
              "exit /b 0",
            ],
          );
          const devinPath = path.join(dir, fake.fileName);
          yield* fs.writeFileString(devinPath, fake.content);
          yield* fs.chmod(devinPath, 0o755);

          return yield* Effect.all({
            withoutCredentials: checkDevinProviderStatus(
              decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
              {},
            ),
            withCredentials: checkDevinProviderStatus(
              decodeDevinSettings({ enabled: true, binaryPath: devinPath, apiKey: "configured" }),
              {},
            ),
          });
        }),
      );

      expect(snapshots.withoutCredentials.status).toBe("ready");
      expect(snapshots.withoutCredentials.installed).toBe(true);
      expect(snapshots.withoutCredentials.auth.status).toBe("unknown");
      expect(snapshots.withCredentials.auth.status).toBe("authenticated");
      expect(snapshots.withoutCredentials.models.map((model) => model.slug)).toEqual([
        "claude-sonnet-5-high",
      ]);
    }),
  );
});
