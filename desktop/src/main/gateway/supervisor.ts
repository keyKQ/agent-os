import { spawn, type ChildProcess } from 'node:child_process'
import type { GatewaySettings } from '@shared/settings'
import { STOPPED_GATEWAY, type GatewayStatus } from '@shared/gateway'
import { locateCli } from './cli-locator'

type Listener = (status: GatewayStatus) => void

/** How long a freshly spawned gateway may take to answer /health. */
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 400

/**
 * Owns the lifecycle of the local gateway process when settings.mode is
 * `managed`. In `external` mode it only checks that the configured endpoint
 * answers and never spawns anything.
 *
 * `running` is only reported once `GET /health` answers, so the renderer can
 * connect the moment it sees that state without its own retry dance.
 *
 * Deliberately thin: the gateway itself owns pid-locking, port binding and
 * auth (see src/agentos/gateway). The shell just starts, watches and stops it.
 */
export class GatewaySupervisor {
  private child: ChildProcess | null = null
  private status: GatewayStatus = { ...STOPPED_GATEWAY }
  private readonly listeners = new Set<Listener>()
  private startGeneration = 0

  private readonly probe: (url: string) => Promise<boolean>
  private readonly locate: (override: string | null) => string | null

  constructor(
    private readonly getSettings: () => GatewaySettings,
    deps: {
      probe?: (url: string) => Promise<boolean>
      locate?: (override: string | null) => string | null
    } = {},
  ) {
    this.probe = deps.probe ?? defaultProbe
    this.locate = deps.locate ?? ((override) => locateCli({ override }))
  }

  current(): GatewayStatus {
    return { ...this.status }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async start(): Promise<GatewayStatus> {
    const cfg = this.getSettings()
    const url = `http://${cfg.host}:${cfg.port}`
    const generation = ++this.startGeneration

    if (cfg.mode === 'external') {
      this.set({ state: 'starting', pid: null, url, error: null })
      const ok = await this.waitReady(url, 5_000, () => generation === this.startGeneration)
      return this.set(
        ok
          ? { state: 'running', pid: null, url, error: null }
          : { state: 'error', pid: null, url: null, error: `No gateway answering at ${url}.` },
      )
    }

    if (this.child && (this.status.state === 'running' || this.status.state === 'starting')) {
      return this.current()
    }

    // A gateway may already be up from a terminal: adopt it instead of
    // fighting over the port. The gateway's own pidlock would reject us anyway.
    if (await this.probe(url)) {
      return this.set({ state: 'running', pid: null, url, error: null })
    }

    const cli = this.locate(cfg.cliPath)
    if (!cli) {
      return this.set({
        state: 'error',
        pid: null,
        url: null,
        error: 'agentos CLI not found. Install it or set gateway.cliPath in settings.',
      })
    }

    this.set({ state: 'starting', pid: null, url, error: null })
    const child = spawn(cli, ['gateway', 'run'], {
      env: {
        ...process.env,
        AGENTOS_GATEWAY__HOST: cfg.host,
        AGENTOS_GATEWAY__PORT: String(cfg.port),
        ...(cfg.token ? { AGENTOS_AUTH__TOKEN: cfg.token, AGENTOS_AUTH__MODE: 'token' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    child.once('error', (err) =>
      this.set({ state: 'error', pid: null, url: null, error: err.message }),
    )
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      const clean = this.status.state === 'stopping' || code === 0
      this.set(
        clean
          ? { ...STOPPED_GATEWAY }
          : {
              state: 'error',
              pid: null,
              url: null,
              error:
                `gateway exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` +
                (stderrTail.trim()
                  ? `\n${stderrTail.trim().split('\n').slice(-3).join('\n')}`
                  : ''),
            },
      )
    })

    const ready = await this.waitReady(
      url,
      READY_TIMEOUT_MS,
      () => generation === this.startGeneration && this.child === child,
    )
    if (this.child !== child) return this.current() // exited or stopped meanwhile
    if (!ready) {
      child.kill('SIGTERM')
      return this.set({
        state: 'error',
        pid: null,
        url: null,
        error: `Gateway did not become healthy within ${READY_TIMEOUT_MS / 1000}s.`,
      })
    }
    return this.set({ state: 'running', pid: child.pid ?? null, url, error: null })
  }

  async stop(): Promise<GatewayStatus> {
    this.startGeneration++
    const child = this.child
    if (!child) {
      return this.set({ ...STOPPED_GATEWAY })
    }
    this.set({ ...this.status, state: 'stopping' })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 8000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
    return this.current()
  }

  private async waitReady(
    url: string,
    timeoutMs: number,
    stillWanted: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && stillWanted()) {
      if (await this.probe(url)) return true
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
    return false
  }

  private set(next: GatewayStatus): GatewayStatus {
    this.status = next
    for (const fn of this.listeners) fn({ ...next })
    return { ...next }
  }
}

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 1500)
    const res = await fetch(`${url}/health`, { signal: ctl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}
