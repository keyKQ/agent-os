import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useRpc } from '@/app/providers'
import { sessionPath } from '~/components/sidebar/SessionRow'
import type { RawProject } from '@/views/projects/logic'
import { projectId, projectName } from '@/views/projects/logic'
import {
  ensureTradingSessionKey,
  readTradingAgentVersion,
  readTradingSessionFiled,
  writeTradingAgentVersion,
  writeTradingSessionFiled,
  writeTradingSessionKey,
} from '~/stores/trading-ui'
import { syncTradingAgent, TRADING_AGENT_ID, TRADING_AGENT_VERSION } from './agent'
import { TRADING_PROJECT_NAME, tradingProjectKnowledge } from './desk-logic'
import { mintTradingSessionKey } from './mode-logic'
import type { Wallet } from '../types'

/**
 * One chat per desk, remembered across launches. The session key is minted
 * here under the desk's own `trading` agent; the gateway creates the session
 * on the first send. The agent itself is the desktop's: it is created (or
 * brought up to this build's spec) the first time the desk is active. Once
 * the session exists, it is filed into the "Trading desk" project (created
 * on demand) whose knowledge tells the agent the current wallets and limits.
 */

export function useTradingSession(
  ctx: {
    wallets: readonly Wallet[]
    chains: readonly number[]
    limits: { thresholdUsd: number; dailyCapUsd: number } | null
  },
  active = true,
): {
  sessionKey: string
  /** Start over in a fresh chat; the old one stays in the sidebar. */
  startFresh: () => void
  /** Call after the first send: files the session into the desk project. */
  ensureFiled: () => void
} {
  const rpc = useRpc()
  const navigate = useNavigate()
  const [sessionKey, setSessionKey] = useState(() => ensureTradingSessionKey(mintTradingSessionKey))
  const filingRef = useRef(false)
  const ctxRef = useRef(ctx)
  useEffect(() => {
    ctxRef.current = ctx
  }, [ctx])

  // The agent is written once per spec version; a failure (gateway busy,
  // registry read-only) leaves the stamp alone so the next launch retries.
  // The chat still works meanwhile: the gateway runs an unregistered agent
  // id with default tools, and the entry takes effect on the next turn.
  const syncingRef = useRef(false)
  useEffect(() => {
    if (!active || syncingRef.current) return
    if (readTradingAgentVersion() >= TRADING_AGENT_VERSION) return
    syncingRef.current = true
    void (async () => {
      try {
        await rpc.waitForConnection()
        await syncTradingAgent(rpc)
        writeTradingAgentVersion(TRADING_AGENT_VERSION)
      } catch {
        // Retried on the next launch.
      } finally {
        syncingRef.current = false
      }
    })()
  }, [rpc, active])

  const ensureFiled = useCallback(() => {
    if (filingRef.current || readTradingSessionFiled()) return
    filingRef.current = true
    void (async () => {
      try {
        await rpc.waitForConnection()
        const list = await rpc.call<{ projects?: RawProject[] }>('projects.list', {})
        let project = (list?.projects ?? []).find((p) => projectName(p) === TRADING_PROJECT_NAME)
        const knowledge = tradingProjectKnowledge(ctxRef.current)
        if (!project) {
          const created = await rpc.call<{ project?: RawProject }>('projects.create', {
            name: TRADING_PROJECT_NAME,
            agentId: TRADING_AGENT_ID,
            knowledge,
          })
          project = created?.project
        } else if (knowledge && (project.knowledge ?? '') !== knowledge) {
          await rpc
            .call('projects.update', { projectId: projectId(project), knowledge })
            .catch(() => {})
        }
        const id = project ? projectId(project) : ''
        if (!id) return
        await rpc.call('sessions.patch', {
          key: sessionKey,
          projectId: id,
          displayName: TRADING_PROJECT_NAME,
        })
        writeTradingSessionFiled(true)
      } catch {
        // The session may not exist yet (nothing sent): try again next time.
      } finally {
        filingRef.current = false
      }
    })()
  }, [rpc, sessionKey])

  // A session that already exists (previous launch) may still be unfiled.
  useEffect(() => {
    if (active && !readTradingSessionFiled()) ensureFiled()
  }, [ensureFiled, active])

  const startFresh = useCallback(() => {
    const fresh = mintTradingSessionKey()
    writeTradingSessionKey(fresh)
    setSessionKey(fresh)
    // The desk's session is a route: the fresh chat is where we go next.
    void navigate(sessionPath(fresh), { replace: true })
  }, [navigate])

  return { sessionKey, startFresh, ensureFiled }
}
