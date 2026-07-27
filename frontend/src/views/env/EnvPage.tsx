import './env.css'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangleIcon,
  CheckIcon,
  EyeIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import { Button } from '@/components/ui/button'
import {
  ENV_QUERY_KEY,
  filterVars,
  groupByCategory,
  isShadowed,
  sourceLabel,
  summarize,
  validateNewName,
  type EnvFilter,
  type EnvListResponse,
  type EnvVarRow,
} from './logic'

const FILTERS: ReadonlyArray<{ id: EnvFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'missing', label: 'Missing' },
  { id: 'set', label: 'Set' },
  { id: 'custom', label: 'Custom' },
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function EnvPage() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<EnvFilter>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newError, setNewError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Environment - AgentOS Control'
  }, [])

  const listQuery = useQuery<EnvListResponse>({
    queryKey: ENV_QUERY_KEY,
    queryFn: () => rpc.call<EnvListResponse>('env.list', {}),
    refetchOnWindowFocus: false,
  })

  const rows = useMemo(() => listQuery.data?.vars ?? [], [listQuery.data])
  const groups = useMemo(
    () => groupByCategory(filterVars(rows, filter, query)),
    [rows, filter, query],
  )
  const summary = useMemo(() => summarize(listQuery.data), [listQuery.data])

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ENV_QUERY_KEY })
  }

  async function save(name: string, value: string) {
    setBusy(name)
    try {
      const result = await rpc.call<EnvVarRow>('env.set', { name, value })
      setEditing(null)
      setDraft('')
      await refresh()
      if (result?.restartRequired) {
        toast.warning(`${name} saved — restart the gateway for it to take full effect.`)
      } else {
        toast.success(`${name} saved.`)
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  async function remove(name: string) {
    setBusy(name)
    try {
      await rpc.call('env.unset', { name })
      await refresh()
      toast.success(`${name} removed.`)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  async function reveal(name: string) {
    setBusy(name)
    try {
      const result = await rpc.call<{ value: string }>('env.reveal', { name })
      setRevealed((prev) => ({ ...prev, [name]: result.value }))
      // Auto-hide: a value left on screen ends up in a screen share or a
      // screenshot long after the operator stopped looking at it.
      window.setTimeout(() => {
        setRevealed((prev) => {
          const next = { ...prev }
          delete next[name]
          return next
        })
      }, 30_000)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  async function addVariable() {
    const problem = validateNewName(newName, rows)
    if (problem) {
      setNewError(problem)
      return
    }
    setNewError(null)
    await save(newName.trim(), newValue)
    setAdding(false)
    setNewName('')
    setNewValue('')
  }

  if (listQuery.isLoading) {
    return (
      <section className="env-stage" aria-busy="true" aria-label="Loading environment variables">
        <div className="env-skeleton env-skeleton--header" />
        <div className="env-skeleton env-skeleton--row" />
        <div className="env-skeleton env-skeleton--row" />
      </section>
    )
  }

  if (listQuery.isError) {
    return (
      <section className="env-stage">
        <div className="env-load-error" role="alert">
          <span aria-hidden="true">
            <AlertTriangleIcon />
          </span>
          <h1>Environment unavailable</h1>
          <p>{errorMessage(listQuery.error)}</p>
          <Button type="button" variant="outline" onClick={() => void listQuery.refetch()}>
            <RefreshCwIcon />
            Retry
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="env-stage">
      <header className="env-stage__header">
        <div className="env-stage__title-block">
          <div className="t-label">Configuration</div>
          <h1 className="t-display">Environment</h1>
          <p>
            {summary.setCount} of {summary.totalCount} variables set ·{' '}
            <code>{listQuery.data?.envFilePath}</code>
          </p>
        </div>
        <div className="env-stage__actions">
          <Button
            type="button"
            variant="outline"
            disabled={listQuery.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className={listQuery.isFetching ? 'env-spin' : undefined} />
            Refresh
          </Button>
          <Button type="button" onClick={() => setAdding((v) => !v)}>
            <PlusIcon />
            Add variable
          </Button>
        </div>
      </header>

      {summary.shadowedCount > 0 ? (
        <div className="env-warning" role="status">
          <span aria-hidden="true">
            <AlertTriangleIcon />
          </span>
          <div>
            <strong>
              {summary.shadowedCount} variable(s) are shadowed by the process environment.
            </strong>
            <p>
              The shell that started the gateway exported them, and that value wins over the file.
              Editing them here will not take effect until the export is removed and the gateway
              restarts.
            </p>
          </div>
        </div>
      ) : null}

      {adding ? (
        <form
          className="env-add"
          onSubmit={(event) => {
            event.preventDefault()
            void addVariable()
          }}
        >
          <label>
            Name
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="MY_SERVICE_TOKEN"
              aria-label="New variable name"
            />
          </label>
          <label>
            Value
            <input
              type="password"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              aria-label="New variable value"
            />
          </label>
          <Button type="submit">Save</Button>
          {newError ? (
            <p className="env-add__error" role="alert">
              {newError}
            </p>
          ) : null}
        </form>
      ) : null}

      <div className="env-toolbar">
        <input
          className="env-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search variables"
          aria-label="Search variables"
        />
        <div className="env-filters" role="group" aria-label="Filter variables">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === filter ? 'env-filter is-active' : 'env-filter'}
              aria-pressed={entry.id === filter}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="env-empty">No variables match this filter.</p>
      ) : (
        groups.map((group) => (
          <section key={group.category} className="env-group" aria-label={group.label}>
            <header className="env-group__header">
              <h2>{group.label}</h2>
              <span>
                {group.setCount}/{group.rows.length} set
              </span>
            </header>
            <ul className="env-list">
              {group.rows.map((row) => (
                <li key={row.name} className="env-row">
                  <div className="env-row__main">
                    <div className="env-row__name">
                      <code>{row.name}</code>
                      {row.writable ? null : (
                        <span
                          className="env-row__lock"
                          title="Blocked by AgentOS security policy — edit ~/.agentos/.env directly if you genuinely need it."
                        >
                          <LockIcon aria-label="Not writable through AgentOS" />
                        </span>
                      )}
                      <span className={row.isSet ? 'env-badge is-set' : 'env-badge'}>
                        {row.isSet ? 'set' : row.missing ? 'missing' : 'unset'}
                      </span>
                      {row.isSet ? (
                        <span className="env-row__source">{sourceLabel(row.source)}</span>
                      ) : null}
                    </div>
                    {row.description ? <p className="env-row__desc">{row.description}</p> : null}
                    {row.owner ? <p className="env-row__owner">Needed by {row.owner}</p> : null}
                    {isShadowed(row) ? (
                      <p className="env-row__shadow">
                        Shadowed by the process environment — changes here take effect only after
                        the export is removed and the gateway restarts.
                      </p>
                    ) : null}
                    {row.url ? (
                      <a
                        className="env-row__link"
                        href={row.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        Where to get this
                      </a>
                    ) : null}
                  </div>

                  <div className="env-row__value">
                    {revealed[row.name] ? (
                      <code className="env-row__revealed">{revealed[row.name]}</code>
                    ) : (
                      <code>{row.masked ?? '—'}</code>
                    )}
                  </div>

                  <div className="env-row__actions">
                    {row.writable ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy === row.name}
                          onClick={() => {
                            setEditing(editing === row.name ? null : row.name)
                            setDraft('')
                          }}
                        >
                          {row.isSet ? 'Edit' : `Set ${row.name}`}
                        </Button>
                        {row.isSet && row.secret ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy === row.name}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Show the real value of ${row.name} on screen? It will hide again after 30 seconds.`,
                                )
                              ) {
                                void reveal(row.name)
                              }
                            }}
                          >
                            <EyeIcon />
                            <span className="sr-only">Reveal {row.name}</span>
                          </Button>
                        ) : null}
                        {row.isSet ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy === row.name}
                            onClick={() => {
                              if (window.confirm(`Remove ${row.name} from the AgentOS .env?`)) {
                                void remove(row.name)
                              }
                            }}
                          >
                            <Trash2Icon />
                            <span className="sr-only">Remove {row.name}</span>
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </div>

                  {editing === row.name ? (
                    <form
                      className="env-row__form"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void save(row.name, draft)
                      }}
                    >
                      <input
                        type={row.secret ? 'password' : 'text'}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        aria-label={`Value for ${row.name}`}
                        autoFocus
                      />
                      <Button type="submit" size="sm" disabled={busy === row.name}>
                        <CheckIcon />
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  )
}
