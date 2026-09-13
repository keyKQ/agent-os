import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import { useConnection } from '@/stores/connection'
import type { RawJob } from '@/views/cron/logic'
import { t } from '~/i18n'
import { errorText } from '../logic'
import {
  isSessionMission,
  jobText,
  MISSION_COMPLETE_MARKER,
  missionCronPayload,
  withoutDryRun,
  type MissionForm,
} from './desk-logic'

/**
 * Missions are cron jobs that post into the desk's chat. This hook reads
 * them back, follows their runs over the cron events, and offers the
 * controls above the composer. The engine's scheduler is the source of
 * truth for every state word shown.
 */

const MISSIONS_KEY = ['trading', 'missions'] as const

interface CronListResult {
  jobs?: RawJob[]
}

interface RunStartPayload {
  jobId?: string
}

interface RunFinishedPayload {
  jobId?: string
  success?: boolean
  summary?: string | null
  sessionKey?: string
}

export interface MissionsApi {
  missions: RawJob[]
  loading: boolean
  /** Job ids with a run in flight right now. */
  running: ReadonlySet<string>
  create: (form: MissionForm, prompt: string) => Promise<RawJob | null>
  update: (id: string, patch: Record<string, unknown>) => Promise<void>
  setEnabled: (job: RawJob, enabled: boolean) => void
  runNow: (job: RawJob) => void
  remove: (job: RawJob) => void
  busy: boolean
}

export function useMissions(sessionKey: string): MissionsApi {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  const connected = useConnection((s) => s.state === 'connected')
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set())

  const query = useQuery<RawJob[]>({
    queryKey: MISSIONS_KEY,
    enabled: connected,
    queryFn: async () => {
      await rpc.waitForConnection()
      const data = await rpc.call<RawJob[] | CronListResult>('cron.list', {})
      return Array.isArray(data) ? data : (data.jobs ?? [])
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  const missions = useMemo(
    () => (query.data ?? []).filter((job) => isSessionMission(job, sessionKey)),
    [query.data, sessionKey],
  )

  // Runs: start marks the job live, finished clears it and refreshes the
  // list (next_run moved). A mission that reports completion turns itself
  // off; a first run in dry-run mode drops the dry-run line for the next.
  useEffect(() => {
    const invalidate = () => void queryClient.invalidateQueries({ queryKey: MISSIONS_KEY })
    const offStart = rpc.on('cron.run.start', (payload) => {
      const id = (payload as RunStartPayload | undefined)?.jobId
      if (!id) return
      setRunning((prev) => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        return next
      })
    })
    const offFinished = rpc.on('cron.run.finished', (payload) => {
      const p = (payload ?? {}) as RunFinishedPayload
      const id = p.jobId
      if (id) {
        setRunning((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
      const job = (queryClient.getQueryData<RawJob[]>(MISSIONS_KEY) ?? []).find((j) => j.id === id)
      if (job && isSessionMission(job, sessionKey)) {
        const summary = String(p.summary ?? '')
        if (summary.includes(MISSION_COMPLETE_MARKER)) {
          void rpc
            .call('cron.update', { id, enabled: false })
            .then(() => toast.success(t('trading.mission.completed'), { id: `mission-${id}` }))
            .catch(() => {})
        } else {
          const text = jobText(job)
          const cleaned = withoutDryRun(text)
          if (cleaned !== text) void rpc.call('cron.update', { id, text: cleaned }).catch(() => {})
        }
      }
      invalidate()
    })
    const offHello = rpc.on('_hello', () => {
      setRunning(new Set())
      invalidate()
    })
    return () => {
      offStart()
      offFinished()
      offHello()
    }
  }, [rpc, queryClient, sessionKey])

  const create = useMutation({
    mutationFn: async ({ form, prompt }: { form: MissionForm; prompt: string }) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      return rpc.call<RawJob | { job?: RawJob }>(
        'cron.add',
        missionCronPayload(form, prompt, sessionKey, tz),
      )
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MISSIONS_KEY }),
  })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      rpc.call('cron.update', { id, ...patch }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MISSIONS_KEY }),
  })
  const run = useMutation({
    mutationFn: (id: string) =>
      rpc.call<{ success?: boolean; status?: string; reason?: string; error?: string | null }>(
        'cron.run',
        { id },
      ),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MISSIONS_KEY }),
  })
  const removeJob = useMutation({
    mutationFn: (id: string) => rpc.call('cron.remove', { id }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MISSIONS_KEY }),
  })

  const fail = (what: string, err: unknown) =>
    toast.error(`${what}: ${errorText(err)}`, { id: 'mission-err' })

  return {
    missions,
    loading: connected && query.isPending,
    running,
    busy: create.isPending || update.isPending || run.isPending || removeJob.isPending,
    create: async (form, prompt) => {
      try {
        const res = await create.mutateAsync({ form, prompt })
        toast.success(t('trading.mission.started'), { id: 'mission-create' })
        const job = (res && 'job' in res ? res.job : res) as RawJob | undefined
        return job ?? null
      } catch (err) {
        fail(t('trading.mission.failed'), err)
        return null
      }
    },
    update: async (id, patch) => {
      try {
        await update.mutateAsync({ id, patch })
        toast.success(t('trading.mission.updated'), { id: 'mission-update' })
      } catch (err) {
        fail(t('trading.mission.failed'), err)
      }
    },
    setEnabled: (job, enabled) => {
      if (!job.id) return
      update.mutate(
        { id: job.id, patch: { enabled } },
        {
          onSuccess: () =>
            toast.success(enabled ? t('trading.mission.resumed') : t('trading.mission.stopped'), {
              id: `mission-${job.id}`,
            }),
          onError: (err) => fail(t('trading.mission.failed'), err),
        },
      )
    },
    runNow: (job) => {
      if (!job.id) return
      run.mutate(job.id, {
        onSuccess: (res) => {
          // A refused run says why; a silent no-op is the one thing not allowed.
          if (res && (res.success === false || res.status === 'blocked' || res.error)) {
            toast.warning(
              `${t('trading.mission.runRefused')}: ${res.reason || res.error || res.status || ''}`,
              { id: `mission-${job.id}` },
            )
          } else toast.success(t('trading.mission.ran'), { id: `mission-${job.id}` })
        },
        onError: (err) => fail(t('trading.mission.failed'), err),
      })
    },
    remove: (job) => {
      if (!job.id) return
      removeJob.mutate(job.id, {
        onSuccess: () => toast.success(t('trading.mission.removed'), { id: `mission-${job.id}` }),
        onError: (err) => fail(t('trading.mission.failed'), err),
      })
    },
  }
}
