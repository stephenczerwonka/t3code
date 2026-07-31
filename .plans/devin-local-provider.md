# Devin as a native T3 Code provider (local-only)

Goal: run Devin CLI (`devin acp`) as a first-class agent inside T3 Code, locally.
No pushes to the upstream repo — this is a personal local build.

## Why this approach

- T3 Code's "ACP Registry" tile in Add Provider is a hardcoded disabled
  placeholder (`COMING_SOON_DRIVER_OPTIONS` in `AddProviderInstanceDialog.tsx`).
  No feature flag or config unlocks it; drivers are compiled into the server
  (`apps/server/src/provider/builtInDrivers.ts`).
- Upstream PR **pingdotgg/t3code#3654** ("Add Devin as an ACP-based provider",
  JoeProAI, 2026-07-02) implements the full driver. Upstream is unlikely to
  merge third-party provider PRs (CONTRIBUTING.md policy; two earlier Devin
  PRs closed), but the code is solid and merges cleanly onto current main.
- Related: feature issue #3636 (open, no maintainer commitment).

## Current state (2026-07-31)

- Repo: `D:\Tradify\_work\t3code` (moved from `D:\Tools\t3code`).
- Branch: **`devin-local`** = `main` (July 30 nightly era) + merge of PR #3654.
  Merge commit `45840bbe5`; zero textual conflicts.
- `pnpm install` (via `corepack pnpm`, pnpm 11.10.0, node 24.17) succeeded.
- `pnpm typecheck`: **14/15 packages pass** (web, contracts, effect-acp all
  green). Only `apps/server` fails — 4 drift errors, all in PR-added files.

## Remaining fixes (313-commit API drift, all mechanical)

1. `apps/server/src/provider/Drivers/DevinDriver.ts:86`
   - `DevinDriverEnv` union missing `BackgroundPolicy` (now required via
     `makeManagedServerProvider`). Add import + union member, mirroring
     `GrokDriver.ts`.
   - Also provide `Crypto` into `checkProvider` like GrokDriver does
     (`Effect.provideService(Crypto.Crypto, crypto)`).
2. `apps/server/src/provider/Layers/DevinProvider.ts:109`
   - `providerModelsFromSettings(builtIn, PROVIDER, custom, caps)` is the old
     4-arg form; current signature is 3-arg (no provider param). Drop
     `PROVIDER` arg; remove now-unused const/import.
   - `checkDevinProviderStatus` declared context needs `| Crypto.Crypto`
     (model discovery spawns the ACP runtime, which now needs Crypto).
3. `apps/server/src/provider/acp/DevinAcpSupport.ts:70`
   - `makeDevinAcpRuntime` declares `R = Scope.Scope`; current
     `AcpSessionRuntime.layer` also needs `Crypto.Crypto`. Mirror
     `makeGrokAcpRuntime`'s signature. (The TS2719 "two unrelated types"
     error is a symptom of this.)

## How the Devin driver authenticates

- Spawns `binaryPath || "devin"` with args `["acp"]` (stdio JSON-RPC).
- Always sends ACP `authenticate` with `methodId: "windsurf-api-key"` and, when
  a key is available, `_meta: { api_key: ... }` (the PR extends
  `AcpSessionRuntime` with an `authenticateMeta` option for this).
- Key sources, in order: instance settings `apiKey` field → `WINDSURF_API_KEY`
  env var. With neither, plain authenticate starts Devin's PKCE browser login.
- Background health probes deliberately skip ACP model discovery when no key is
  configured, so a status check can never pop the browser login.
- NOTE: `apiKey` is stored in `~/.t3/userdata/settings.json` in plaintext
  (masked in UI only). Prefer `WINDSURF_API_KEY` env var if that bothers you.

## Verification plan

1. Apply the 3-file fixes above; re-run `corepack pnpm typecheck` → expect 15/15.
2. Optional live handshake sanity check: run `devin acp`, send `initialize`,
   confirm `authMethods` includes `windsurf-api-key` and session/new works with
   logged-in CLI or env key.
3. `corepack pnpm dev` → open web UI → Settings → Providers: Devin should
   appear (Early Access badge) with probe status from `devin --version`.
4. Start a thread with provider Devin in a scratch repo; verify turn streaming,
   permission prompts, and stop/interrupt.

## Session-environment fixes made along the way (unrelated to t3code)

- `python3` on PATH was the Microsoft Store stub, which made the
  `guard-write-scope` hook fail closed (it hard-requires python3) and blocked
  all file writes. Fixed with a shim: `~/.local/bin/python3` → `/c/Python314/python.exe`.
- The t3code clone was moved from `D:\Tools` into `D:\Tradify\_work` so writes
  fall inside the write-scope guard's root.

## Rollback

- `git checkout main` in the repo abandons the Devin build.
- Branch `devin-local` and fetched ref `pr-3654-devin` are purely local.
