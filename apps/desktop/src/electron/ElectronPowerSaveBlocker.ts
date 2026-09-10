import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

/**
 * Holds a `powerSaveBlocker` ("prevent-app-suspension") while any turn is
 * running. Locking or closing the lid otherwise lets the OS suspend and
 * freezes every in-flight agent turn mid-work; the display may still sleep
 * normally. The block is reference-counted by a single boolean — the
 * renderer reports "any turn running" and idempotent set calls collapse.
 */
export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    readonly setTurnActivity: (turnRunning: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronPowerSaveBlocker") {}

export const layer = Layer.effect(
  ElectronPowerSaveBlocker,
  Effect.gen(function* () {
    const blockerIdRef = yield* Ref.make<number | undefined>(undefined);
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(blockerIdRef), (blockerId) =>
        Effect.sync(() => {
          if (blockerId !== undefined && Electron.powerSaveBlocker.isStarted(blockerId)) {
            Electron.powerSaveBlocker.stop(blockerId);
          }
        }),
      ),
    );

    const setTurnActivity = Effect.fn("ElectronPowerSaveBlocker.setTurnActivity")(function* (
      turnRunning: boolean,
    ) {
      const blockerId = yield* Ref.get(blockerIdRef);
      if (turnRunning && blockerId === undefined) {
        yield* Ref.set(blockerIdRef, Electron.powerSaveBlocker.start("prevent-app-suspension"));
      } else if (!turnRunning && blockerId !== undefined) {
        if (Electron.powerSaveBlocker.isStarted(blockerId)) {
          Electron.powerSaveBlocker.stop(blockerId);
        }
        yield* Ref.set(blockerIdRef, undefined);
      }
    });

    return ElectronPowerSaveBlocker.of({ setTurnActivity });
  }),
);
