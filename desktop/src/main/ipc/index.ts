import type { GatewaySupervisor } from '../gateway/supervisor'
import type { SettingsStore } from '../settings/store'
import { registerAppIpc } from './app'
import { registerGatewayIpc } from './gateway'
import { registerSettingsIpc } from './settings'
import { registerThemeIpc } from './theme'

export interface MainServices {
  settings: SettingsStore
  gateway: GatewaySupervisor
}

/** Register every IPC handler exactly once, before the first window opens. */
export function registerIpc(services: MainServices): void {
  registerSettingsIpc(services.settings)
  registerAppIpc(services.settings)
  registerThemeIpc(services.settings)
  registerGatewayIpc(services.gateway)
}
