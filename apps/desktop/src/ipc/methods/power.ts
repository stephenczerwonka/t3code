import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronPowerSaveBlocker from "../../electron/ElectronPowerSaveBlocker.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setTurnActivity = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_TURN_ACTIVITY_CHANNEL,
  payload: Schema.Struct({ turnRunning: Schema.Boolean }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.power.setTurnActivity")(function* (input) {
    const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
    yield* powerSaveBlocker.setTurnActivity(input.turnRunning);
  }),
});
