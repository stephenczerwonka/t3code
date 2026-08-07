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
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
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
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            ["#!/bin/sh", 'printf "devin 2026.8.18\\n"', "exit 0", ""].join("\n"),
          );
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

  it.effect("loads model variants from the CLI catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-success-" });
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "devin 2026.8.18\\n"',
              "else",
              `  printf '%s\\n' '{"families":[{"variants":[{"model_uid":"claude-sonnet-5-high","label":"Claude Sonnet 5 High"}]}]}'`,
              "fi",
              "exit 0",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            {},
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["claude-sonnet-5-high"]);
    }),
  );
});
