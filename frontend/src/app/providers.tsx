import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { fetchBootstrap, type Bootstrap } from '@/lib/bootstrap'
import { WsRpcClient } from '@/lib/ws-rpc'
import { useConnection } from '@/stores/connection'
import { initTheme } from '@/stores/theme'
import type { RpcState } from '@/lib/ws-rpc'

const WS_URL_KEY = 'agentos.wsUrl'
const WS_TOKEN_KEY = 'agentos.wsToken'

const RpcContext = createContext<WsRpcClient | null>(null)
const BootstrapContext = createContext<Bootstrap | null>(null)

export function useRpc(): WsRpcClient {
  const rpc = useContext(RpcContext)
  if (!rpc) throw new Error('useRpc outside AppProviders')
  return rpc
}

export function useBootstrap(): Bootstrap {
  const b = useContext(BootstrapContext)
  if (!b) throw new Error('useBootstrap outside AppProviders')
  return b
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
})

export function AppProviders({ children }: { children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [rpc] = useState(() => new WsRpcClient())

  useEffect(() => {
    initTheme()
    let cancelled = false
    const unsubscribe = rpc.on('_state', (s) => useConnection.getState().setState(s as RpcState))
    fetchBootstrap().then((b) => {
      if (cancelled) return
      setBootstrap(b)
      const url = localStorage.getItem(WS_URL_KEY) || b.ws_url
      const token = localStorage.getItem(WS_TOKEN_KEY)
      rpc.connect(url, token)
    })
    return () => {
      cancelled = true
      unsubscribe()
      rpc.disconnect()
    }
  }, [rpc])

  if (!bootstrap) return <div className="p-8 text-sm">Connecting…</div>

  return (
    <BootstrapContext.Provider value={bootstrap}>
      <RpcContext.Provider value={rpc}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </RpcContext.Provider>
    </BootstrapContext.Provider>
  )
}
