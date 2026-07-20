// Channels section (setup.js:664-714,1857-1875). Pick a channel type, fill its
// fields, and Save = probe then upsert (onboarding.channel.probe →
// onboarding.channel.upsert). Runtime status rows come from channels.status
// (polled by the orchestrator). Required-field validation blocks submit;
// secrets are masked and a configured channel may keep its existing secret.
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NeedList, PanelHead, SetupField } from './parts'
import {
  readScopedFields,
  validateScopedRequiredFields,
  type Catalog,
  type ChannelSpec,
  type FieldSpec,
  type ScopedField,
} from './logic'

interface RuntimeRow {
  name?: string
  type?: string
  status?: string
  connected?: boolean
  configured?: boolean
}
export interface ChannelsRuntimeStatus {
  channels?: RuntimeRow[]
}

type Draft = Record<string, { value: string; checked: boolean }>

function seedDraft(fields: FieldSpec[]): Draft {
  const draft: Draft = {}
  fields.forEach((f) => {
    draft[f.name] = {
      value: f.type === 'bool' ? '' : String(f.default ?? ''),
      checked: f.type === 'bool' ? Boolean(f.default) : false,
    }
  })
  return draft
}

function statusRow(row: RuntimeRow): { label: string; tone: string } {
  const connected = row.connected === true
  const state = connected
    ? 'Connected'
    : row.status === 'stopped'
      ? 'Action needed'
      : row.status || 'connecting'
  return { label: state, tone: connected ? 'tone-ok' : 'tone-warn' }
}

export function ChannelsSection({
  catalog,
  channelStatus,
  onSave,
  onBack,
  onNext,
  onDirtyChange,
  saving,
  onValidationError,
}: {
  catalog: Catalog
  channelStatus: ChannelsRuntimeStatus
  onSave: (entry: Record<string, unknown>) => void
  onBack: () => void
  onNext: () => void
  onDirtyChange: (dirty: boolean) => void
  saving: boolean
  onValidationError: (message: string) => void
}) {
  const channels = catalog.channels || []
  const [selected, setSelected] = useState(channels[0]?.type || 'telegram')
  const spec: ChannelSpec | undefined = channels.find((c) => c.type === selected)

  const [draftKey, setDraftKey] = useState(selected)
  const [draft, setDraft] = useState<Draft>(() => seedDraft(spec?.fields || []))
  if (draftKey !== selected) {
    setDraftKey(selected)
    setDraft(seedDraft(spec?.fields || []))
  }

  const runtimeRows = useMemo(
    () => (channelStatus.channels || []).filter((r) => r.configured !== false),
    [channelStatus.channels],
  )

  const markDirty = () => onDirtyChange(true)

  const setValue = (name: string, value: string) => {
    setDraft((d) => ({ ...d, [name]: { ...d[name]!, value } }))
    markDirty()
  }
  const setChecked = (name: string, checked: boolean) => {
    setDraft((d) => ({ ...d, [name]: { ...d[name]!, checked } }))
    markDirty()
  }

  const scopedFields = (): ScopedField[] =>
    (spec?.fields || []).map((f) => ({
      name: f.name,
      value: draft[f.name]?.value ?? '',
      checked: draft[f.name]?.checked ?? false,
      type:
        f.type === 'bool' ? 'checkbox' : f.secret || f.type === 'password' ? 'password' : 'text',
      secret: Boolean(f.secret || f.type === 'password'),
      required: Boolean(f.required),
      hidden: false,
      label: f.label,
    }))

  // setup.js:1732-1741 — a configured channel of this type+name may keep its secret.
  const canKeepSecret = (): boolean => {
    const nameField = draft['name']?.value || ''
    return runtimeRows.some(
      (row) =>
        row.configured !== false &&
        String(row.type || '') === String(selected) &&
        String(row.name || '') === String(nameField).trim(),
    )
  }

  const collectAndSave = () => {
    const fields = scopedFields()
    const missing = validateScopedRequiredFields(fields, canKeepSecret())
    if (missing) {
      onValidationError(`${missing} is required.`)
      return
    }
    const entry = { type: selected, ...readScopedFields(fields, 'channel') }
    onSave(entry)
  }

  return (
    <section className="setup-panel panel">
      <PanelHead title="Channels" subtitle={`${runtimeRows.length} configured`} />
      <div className="setup-channel-grid">
        <div className="setup-form">
          <label>
            <span>Channel type</span>
            <select
              aria-label="Channel type"
              value={selected}
              onChange={(e) => {
                markDirty()
                setSelected(e.target.value)
              }}
            >
              {channels.map((c) => (
                <option key={c.type} value={c.type}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <NeedList items={spec?.whatYouNeed} label="Channel needs" />
          <div className="setup-channel-fields">
            {(spec?.fields || []).map((f) => (
              <SetupField
                key={f.name}
                field={f}
                value={draft[f.name]?.value ?? ''}
                checked={draft[f.name]?.checked ?? false}
                hidden={false}
                onChange={(v) => setValue(f.name, v)}
                onToggle={(c) => setChecked(f.name, c)}
              />
            ))}
          </div>
          <div className="setup-actions">
            <Button type="button" disabled={saving} onClick={collectAndSave}>
              Save Channel
            </Button>
          </div>
        </div>
        <div className="setup-runtime">
          <h4 className="t-label">Runtime status</h4>
          {runtimeRows.length ? (
            runtimeRows.map((row, i) => {
              const s = statusRow(row)
              return (
                <div className={`setup-runtime__row ${s.tone}`} key={String(row.name || i)}>
                  <span>{row.name}</span>
                  <span className="t-data">{row.type || ''}</span>
                  <strong>{s.label}</strong>
                </div>
              )
            })
          ) : (
            <p className="setup-muted">No channels configured.</p>
          )}
        </div>
      </div>
      <div className="setup-actions">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="outline" onClick={onNext}>
          Next
        </Button>
      </div>
    </section>
  )
}
