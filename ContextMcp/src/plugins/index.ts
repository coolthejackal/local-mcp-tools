import { registerPlugin } from "./pluginManager"
import { ReactPlugin } from "./reactPlugin"
import { DevExtremePlugin } from "./devextremePlugin"

export function loadPlugins() {
  registerPlugin(ReactPlugin)
  registerPlugin(DevExtremePlugin)
}