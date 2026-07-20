import './cron.css'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PencilIcon, PlusIcon, RefreshCwIcon, SendIcon, SquareIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { AsciiField } from '@/components/AsciiField'
import { Button } from '@/components/ui/button'
import { useRpc } from '@/app/providers'
import { relTime } from '@/views/overview/logic'
import {
  explainCron,
  filterJobs,
  humanCountdownPast,
  isOkStatus,
  isUpcomingRun,
  jobDotState,
  jobKindClass,
  jobKindLabel,
  jobSchedule,
  jobTarget,
  nextRunAbs,
  nextRunText,
  runRow,
  sortJobs,
  type CronDot,
  type RawJob,
  type RawRun,
  type SortCol,
} from './logic'

// cron.js:341-342 — cron.list may return a bare array or {jobs:[…]}.
interface CronListResult {
  jobs?: RawJob[]
}
interface CronRunsResult {
  runs?: RawRun[]
}

// dot state → --tone bucket (status color ONLY via --tone; never hardcoded).
function dotTone(state: CronDot): string {
  return state === 'error' ? 'tone-danger' : state === 'off' ? 'tone-dim' : 'tone-ok'
}

function StatTile({
  label,
  value,
  hint,
  hero,
}: {
  label: string
  value: React.ReactNode
  hint: React.ReactNode
  hero?: boolean
}) {
  return (
    <div className={`cron-stat${hero ? ' cron-stat--hero' : ''}`} aria-label={label}>
      <span className="cron-stat__label t-label">{label}</span>
      <strong className="cron-stat__value t-data">{value}</strong>
      <span className="cron-stat__hint">{hint}</span>
    </div>
  )
}

// ── Run-history drawer (cron.js:863-923) ─────────────────────────────────────
function RunsDrawer({
  jobId,
  jobName,
  onClose,
}: {
  jobId: string
  jobName: string
  onClose: () => void
}) {
  const rpc = useRpc()
  const navigate = useNavigate()

  // cron.js:883 — cron.runs {id, limit:10}; a failure surfaces an inline note.
  const runsQuery = useQuery<RawRun[]>({
    queryKey: ['cron', 'runs', jobId],
    queryFn: async () => {
      await rpc.waitForConnection()
      const data = await rpc.call<RawRun[] | CronRunsResult>('cron.runs', { id: jobId, limit: 10 })
      return Array.isArray(data) ? data : (data.runs ?? [])
    },
    refetchOnWindowFocus: false,
  })

  const runs = runsQuery.data ?? []

  return (
    <div className="cron-detail panel" aria-label={`Run history for ${jobName}`}>
      <div className="cron-detail__head">
        <div>
          <span className="cron-detail__eyebrow t-label">Run history</span>
          <strong className="cron-detail__name">{jobName}</strong>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close run history"
        >
          Close
        </Button>
      </div>

      {runsQuery.isError ? (
        <p className="cron-muted">Failed to load run history.</p>
      ) : runsQuery.isLoading ? (
        <p className="cron-muted">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="cron-muted">No run history yet.</p>
      ) : (
        <table className="cron-runs">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Delivery</th>
              <th>Reply</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r, i) => {
              const row = runRow(r, relTime)
              return (
                <tr key={i}>
                  <td className="cron-mono">{row.timeLabel}</td>
                  <td>
                    <span className={`cron-status ${row.statusOk ? 'tone-ok' : 'tone-danger'}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="cron-mono">{row.duration}</td>
                  <td>{row.delivery}</td>
                  <td className="cron-runs__reply">{row.reply}</td>
                  <td>
                    {row.sessionKey ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          navigate('/chat?session=' + encodeURIComponent(row.sessionKey))
                        }
                      >
                        → Chat
                      </Button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Job card (cron.js:612-650) ───────────────────────────────────────────────
function JobCard({
  job,
  busy,
  selected,
  onOpen,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  job: RawJob
  busy: boolean
  selected: boolean
  onOpen: (id: string) => void
  onToggle: (job: RawJob) => void
  onRun: (id: string) => void
  onEdit: (job: RawJob) => void
  onDelete: (job: RawJob) => void
}) {
  const id = String(job.id ?? '')
  const name = String(job.name || job.id || '')
  const enabled = !!job.enabled
  const dot = jobDotState(job)
  const lastStatus = job.last_status || (job.last_run ? 'ok' : null)
  const lastRun = job.last_run ? humanCountdownPast(new Date(job.last_run as string | number)) : '—'
  const nextRun = nextRunText(job)
  const nextAbs = nextRunAbs(job)
  const schedule = jobSchedule(job)
  const human = explainCron(job.expression || '') || ''
  const kind = jobKindLabel(job)
  const kindClass = jobKindClass(job)
  const target = jobTarget(job)
  const message = String(job.message || job.prompt || '').trim()

  return (
    <article
      className={`panel cron-card ${dotTone(dot)}${selected ? ' is-selected' : ''}`}
      aria-label={`Cron job ${name}`}
    >
      <header className="cron-card__head">
        <span
          className={`cron-card__dot tone-${dot === 'error' ? 'danger' : dot === 'off' ? 'dim' : 'ok'}`}
          aria-hidden="true"
        />
        <button
          type="button"
          className="cron-card__name"
          title="Show run history"
          onClick={() => onOpen(id)}
        >
          {name}
        </button>
        <span className={`cron-pill cron-pill--${kindClass}`}>{kind}</span>
      </header>

      <div className="cron-card__schedule">
        <code className="cron-expr">{schedule}</code>
        {human ? <span className="cron-card__human">{human}</span> : null}
      </div>

      <dl className="cron-card__meta">
        <div>
          <dt className="t-label">Target</dt>
          <dd className="t-data">{target}</dd>
        </div>
        <div>
          <dt className="t-label">Last run</dt>
          <dd className="t-data">
            {lastRun}
            {lastStatus ? (
              <>
                {' · '}
                <span
                  className={`cron-status ${isOkStatus(lastStatus) ? 'tone-ok' : 'tone-danger'}`}
                >
                  {lastStatus}
                </span>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="t-label">Next run</dt>
          <dd className="t-data">
            {enabled ? (
              <>
                <span className="cron-mono">{nextRun}</span>
                {nextAbs ? <span className="cron-card__abs"> · {nextAbs}</span> : null}
              </>
            ) : (
              <span className="cron-muted">paused</span>
            )}
          </dd>
        </div>
        {message ? (
          <div className="cron-card__message">
            <dt className="t-label">Prompt</dt>
            <dd className="t-data">
              {message.length > 140 ? message.slice(0, 140) + '…' : message}
            </dd>
          </div>
        ) : null}
      </dl>

      <footer className="cron-card__actions">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          aria-label={`Run ${name} now`}
          onClick={() => onRun(id)}
        >
          <SendIcon />
          <span>Run</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          aria-label={`${enabled ? 'Pause' : 'Resume'} ${name}`}
          onClick={() => onToggle(job)}
        >
          {enabled ? <SquareIcon /> : <SendIcon />}
          <span>{enabled ? 'Pause' : 'Resume'}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Edit ${name}`}
          onClick={() => onEdit(job)}
        >
          <PencilIcon />
          <span>Edit</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy}
          aria-label={`Delete ${name}`}
          onClick={() => onDelete(job)}
        >
          <Trash2Icon />
        </Button>
      </footer>
    </article>
  )
}

// ── Delete confirmation (cron.js:773-787) ────────────────────────────────────
function DeleteConfirm({
  jobName,
  busy,
  onCancel,
  onConfirm,
}: {
  jobName: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="cron-modal__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div
        className="cron-modal panel"
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete schedule"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.stopPropagation()
            onCancel()
          }
        }}
      >
        <h3 className="cron-modal__title">Delete schedule</h3>
        <p className="cron-modal__body">
          Delete <strong>{jobName}</strong>? This cannot be undone.
        </p>
        <footer className="cron-modal__foot">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            Delete
          </Button>
        </footer>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function CronPage() {
  const rpc = useRpc()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState<SortCol>('next_run')
  const [sortAsc] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RawJob | null>(null)

  useEffect(() => {
    document.title = 'Cron - AgentOS Control'
  }, [])

  // cron.js:339-347 — cron.list after waitForConnection (array or {jobs}).
  const jobsQuery = useQuery<RawJob[]>({
    queryKey: ['cron'],
    queryFn: async () => {
      await rpc.waitForConnection()
      const data = await rpc.call<RawJob[] | CronListResult>('cron.list', {})
      return Array.isArray(data) ? data : (data.jobs ?? [])
    },
    refetchOnWindowFocus: false,
  })

  // cron.js:346 — load-failure toast (stable id so repeats dedupe).
  useEffect(() => {
    if (jobsQuery.isError) {
      const err = jobsQuery.error
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Failed to load cron jobs: ' + message, { id: 'cron-load-err' })
    }
  }, [jobsQuery.isError, jobsQuery.error])

  // cron.js:306-316,318-321 — the subscribe/unsubscribe lifecycle. Legacy
  // subscribes on render and unsubscribes on destroy. In React this is a mount
  // effect: cron.subscribe after the WS handshake (best-effort; a pre-connect
  // call rejects with "Not connected"), and cron.unsubscribe in the cleanup.
  // The cleanup runs on every unmount (incl. StrictMode's dev double-invoke),
  // so no subscription leaks across remounts.
  useEffect(() => {
    let cancelled = false
    rpc
      .waitForConnection()
      .then(() => {
        if (!cancelled) return rpc.call('cron.subscribe', {})
        return undefined
      })
      .catch(() => {
        /* subscription is best-effort */
      })
    return () => {
      cancelled = true
      rpc.call('cron.unsubscribe', {}).catch(() => {
        /* best-effort; ignore disconnected state */
      })
    }
  }, [rpc])

  // cron.js:313-315 — cron.run.finished → invalidate the job list AND any open
  // runs drawer (targeted refetch). Cleaned up on unmount so the listener never
  // leaks (StrictMode-safe: the unsub closure removes exactly this handler).
  useEffect(() => {
    const unsub = rpc.on('cron.run.finished', () => {
      void queryClient.invalidateQueries({ queryKey: ['cron'] })
    })
    return () => {
      unsub()
    }
  }, [rpc, queryClient])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['cron'] })

  // cron.js:735-744 — enable/disable toggle → cron.update {id, enabled:!enabled}.
  const toggleMutation = useMutation({
    mutationFn: (job: RawJob) => rpc.call('cron.update', { id: job.id, enabled: !job.enabled }),
    onSuccess: (_data, job) => {
      toast.info(`Job ${job.enabled ? 'paused' : 'resumed'}`, { id: 'cron-toggle' })
      void invalidate()
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Update failed: ' + message, { id: 'cron-toggle-err' })
    },
  })

  // cron.js:746-766 — run-now → cron.run {id}; surface reply/error/triggered.
  const runMutation = useMutation({
    mutationFn: (id: string) => rpc.call<{ reply?: string; error?: string }>('cron.run', { id }),
    onSuccess: (res) => {
      if (res && res.reply) {
        toast.success('Run complete: ' + res.reply.substring(0, 120), { id: 'cron-run' })
      } else if (res && res.error) {
        toast.warning('Run failed: ' + res.error, { id: 'cron-run' })
      } else {
        toast.success('Job triggered', { id: 'cron-run' })
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Run failed: ' + message, { id: 'cron-run-err' })
    },
  })

  // cron.js:768-788 — delete after confirmation → cron.remove {id}.
  const removeMutation = useMutation({
    mutationFn: (id: string) => rpc.call('cron.remove', { id }),
    onSuccess: (_data, id) => {
      toast.info('Job deleted', { id: 'cron-remove' })
      if (selectedId === id) setSelectedId(null)
      setPendingDelete(null)
      void invalidate()
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Delete failed: ' + message, { id: 'cron-remove-err' })
    },
  })

  const jobs = jobsQuery.data ?? []
  const busy = toggleMutation.isPending || runMutation.isPending || removeMutation.isPending

  // cron.js:381-405 — summary stats.
  const total = jobs.length
  const enabledCount = jobs.filter((j) => j.enabled).length
  const paused = total - enabledCount
  const upcoming = jobs.filter((j) => isUpcomingRun(j)).length
  const reminders = jobs.filter((j) => (j.payloadKind || j.payload_kind) === 'reminder').length
  const agentTasks = jobs.filter((j) => (j.payloadKind || j.payload_kind) === 'agent_turn').length

  // cron.js:562-570 — filter then sort.
  const visible = sortJobs(filterJobs(jobs, search), sortCol, sortAsc)

  const selectedJob = selectedId ? jobs.find((j) => String(j.id) === selectedId) : undefined

  return (
    <div className="cron-stage">
      <header className="cron-stage__header">
        <AsciiField />
        <div className="cron-stage__title-block">
          <span className="t-label">Control · Schedule</span>
          <h2 className="t-display">Cron</h2>
          <p className="cron-stage__subtitle">
            Time-driven tasks — orchestrate reminders, agent turns, and recurring work.
          </p>
        </div>
        <div className="cron-stage__actions">
          <input
            className="cron-search t-data"
            type="search"
            placeholder="Search jobs…"
            autoComplete="off"
            aria-label="Search jobs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="cron-sort">
            <span className="t-label">Sort</span>
            <select
              className="cron-sort__select t-data"
              aria-label="Sort jobs"
              value={sortCol}
              onChange={(e) => setSortCol(e.target.value as SortCol)}
            >
              <option value="next_run">Next run</option>
              <option value="name">Name</option>
              <option value="last_run">Last run</option>
              <option value="payloadKind">Kind</option>
              <option value="sessionTarget">Target</option>
              <option value="expression">Schedule</option>
            </select>
          </label>
          <Button
            variant="outline"
            title="Refresh"
            className="text-xs uppercase tracking-[0.14em]"
            onClick={() => void invalidate()}
          >
            <RefreshCwIcon />
            <span>Refresh</span>
          </Button>
        </div>
      </header>

      <section className="cron-stats" aria-label="Cron summary">
        <StatTile
          label="Active schedules"
          hero
          value={enabledCount}
          hint={paused ? `${paused} paused` : total ? 'all enabled' : 'none configured'}
        />
        <StatTile
          label="Upcoming runs"
          value={upcoming}
          hint={upcoming ? 'scheduled ahead' : 'no upcoming runs'}
        />
        <StatTile label="Reminders" value={reminders} hint="static reminders" />
        <StatTile label="Agent tasks" value={agentTasks} hint="scheduled turns" />
      </section>

      <section className="cron-list">
        <div className="cron-list__head">
          <h3 className="cron-list__title t-label">
            {search ? 'Matching schedules' : 'All schedules'}{' '}
            <span className="cron-list__count t-data">
              {visible.length}
              {search ? ` of ${total}` : ''}
            </span>
          </h3>
        </div>

        {jobs.length === 0 ? (
          <div className="cron-empty">
            <div className="cron-empty__title">No schedules yet.</div>
            <p className="cron-empty__msg">
              Create a cron job to wake an agent, fire a reminder, or kick off recurring work — all
              on time. Schedule creation stays in the CLI so payloads, delivery, and session targets
              stay explicit.
            </p>
            <div className="cron-empty__actions">
              <Button type="button" onClick={() => navigate('/chat')}>
                <PlusIcon />
                <span>Ask an agent to schedule it</span>
              </Button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="cron-empty">
            <div className="cron-empty__title">No matches</div>
            <p className="cron-empty__msg">
              No schedules match your search. Try a different query, or clear it to see everything.
            </p>
          </div>
        ) : (
          <div className="cron-cards">
            {visible.map((job, i) => (
              <JobCard
                key={String(job.id ?? i)}
                job={job}
                busy={busy}
                selected={selectedId === String(job.id)}
                onOpen={(id) => setSelectedId((cur) => (cur === id ? null : id))}
                onToggle={(j) => toggleMutation.mutate(j)}
                onRun={(id) => runMutation.mutate(id)}
                onEdit={() =>
                  toast.info('Editing schedules stays in the CLI: agentos cron edit', {
                    id: 'cron-edit',
                  })
                }
                onDelete={(j) => setPendingDelete(j)}
              />
            ))}
          </div>
        )}

        {selectedJob ? (
          <RunsDrawer
            jobId={String(selectedJob.id)}
            jobName={String(selectedJob.name || selectedJob.id)}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </section>

      {pendingDelete ? (
        <DeleteConfirm
          jobName={String(pendingDelete.name || pendingDelete.id)}
          busy={removeMutation.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => removeMutation.mutate(String(pendingDelete.id))}
        />
      ) : null}
    </div>
  )
}
