import type { GatewaySupervisor } from '../gateway/supervisor'
import type { PetStore } from '../pets/store'
import type { SettingsStore } from '../settings/store'
import { registerAppIpc } from './app'
import { registerGatewayIpc } from './gateway'
import { registerNotifyIpc } from './notify'
import { registerPetsIpc } from './pets'
import { registerSettingsIpc } from './settings'
import { registerThemeIpc } from './theme'

export interface MainServices {
  settings: SettingsStore
  gateway: GatewaySupervisor
  pets: PetStore
}

/** Register every IPC handler exactly once, before the first window opens. */
export function registerIpc(services: MainServices): void {
  registerSettingsIpc(services.settings)
  registerAppIpc(services.settings)
  registerThemeIpc(services.settings)
  registerGatewayIpc(services.gateway)
  registerPetsIpc(services.pets)
  registerNotifyIpc()
}
