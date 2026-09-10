import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { Sidebar } from '~/components/Sidebar'
import { Toolbar } from '~/components/Toolbar'
import { bindGatewayEvents } from '~/stores/gateway'

/** Window chrome: translucent full-height sidebar, then toolbar + routed content. */
export function AppShell() {
  useEffect(() => bindGatewayEvents(), [])

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="mac-content flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <main className="relative z-[2] min-h-0 flex-1 overflow-auto" data-selectable>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
