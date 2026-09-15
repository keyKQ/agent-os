import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { RawJob } from '@/views/cron/logic'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { sameAddress, walletLabel } from '../logic'
import { Sheet } from '../parts'
import { CHAINS, type Limits, type Wallet } from '../types'
import {
  composeMissionPrompt,
  INTERVALS,
  missionFromJob,
  missionPrefill,
  validateMission,
  type MissionError,
  type MissionForm,
  type MissionKind,
} from './desk-logic'

/**
 * The contract: what the mission may do, with what money, how often, until
 * when. The prompt the agent will read is composed from these fields and
 * shown in full, so nothing is signed that was not seen. A `swap` contract
 * is a one-shot prompt; everything else becomes a scheduled job.
 */
export function MissionContract({
  kind,
  job,
  wallets,
  primary,
  limits,
  onClose,
  onSend,
  onCreate,
  onUpdate,
}: {
  kind: MissionKind
  /** Editing an existing mission. */
  job?: RawJob | null
  wallets: readonly Wallet[]
  primary: string | null
  limits: Limits | null
  onClose: () => void
  /** One-shot: send the prompt into the chat. */
  onSend: (prompt: string) => void
  /** Resolves null when the gateway refused: the contract stays open to retry. */
  onCreate: (form: MissionForm, prompt: string) => Promise<unknown>
  /** Resolves false when the gateway refused: the contract stays open to retry. */
  onUpdate: (id: string, form: MissionForm, prompt: string) => Promise<unknown>
}) {
  const [form, setForm] = useState<MissionForm>(() =>
    job ? missionFromJob(job, primary, wallets) : missionPrefill(kind, { primary }),
  )
  const [showPrompt, setShowPrompt] = useState(false)
  const [saving, setSaving] = useState(false)
  // Validation copy waits for an attempt or an edit: a pristine form is not wrong yet.
  const [touched, setTouched] = useState(false)
  const prompt = useMemo(
    () =>
      composeMissionPrompt(form, {
        wallets,
        limits: limits
          ? { thresholdUsd: limits.thresholdUsd, dailyCapUsd: limits.dailyCapUsd }
          : null,
      }),
    [form, wallets, limits],
  )
  const check = validateMission(form)
  const oneShot = form.kind === 'swap'
  const patch = (p: Partial<MissionForm>) => {
    setTouched(true)
    setForm((f) => ({ ...f, ...p }))
  }

  async function submit() {
    setTouched(true)
    if (!check.ok) return
    if (oneShot) {
      onSend(prompt)
      onClose()
      return
    }
    setSaving(true)
    try {
      const res = job?.id ? await onUpdate(job.id, form, prompt) : await onCreate(form, prompt)
      // A refusal has already been toasted; closing would throw the contract away.
      if (res === null || res === false) return
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const title = job ? t('trading.contract.editTitle') : t('trading.contract.title')

  return (
    <Sheet
      title={title}
      onClose={onClose}
      wide
      foot={
        <>
          <Button onClick={onClose}>{t('trading.contract.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!check.ok || saving}
            onClick={() => void submit()}
            data-testid="contract-submit"
          >
            {oneShot
              ? t('trading.contract.send')
              : job
                ? t('trading.contract.save')
                : t('trading.contract.start')}
          </Button>
        </>
      }
      note={
        touched && !check.ok && check.error ? (
          <span className="text-danger">
            {t(`trading.contract.error.${check.error as MissionError}`)}
          </span>
        ) : null
      }
    >
      <div className="trd-contract" data-testid="mission-contract">
        <label className="trd-field">
          <span>{t('trading.contract.name')}</span>
          <input
            className="mac-input"
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            data-testid="contract-name"
          />
        </label>
        <label className="trd-field">
          <span>{t('trading.contract.goal')}</span>
          <textarea
            className="mac-input trd-contract__goal"
            rows={3}
            value={form.goal}
            onChange={(e) => patch({ goal: e.target.value })}
            data-testid="contract-goal"
          />
        </label>

        <div className="trd-contract__grid">
          <fieldset className="trd-field">
            <legend>{t('trading.contract.wallets')}</legend>
            <div className="trd-contract__checks">
              {wallets.map((w) => {
                const on = form.wallets.some((a) => sameAddress(a, w.address))
                return (
                  <label key={w.address} className="trd-contract__check">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        patch({
                          wallets: e.target.checked
                            ? [...form.wallets, w.address]
                            : form.wallets.filter((a) => !sameAddress(a, w.address)),
                        })
                      }
                    />
                    <span>{walletLabel(w)}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          <fieldset className="trd-field">
            <legend>{t('trading.contract.chains')}</legend>
            <div className="trd-contract__checks">
              {CHAINS.map((c) => {
                const on = form.chains.includes(c.id)
                return (
                  <label key={c.id} className="trd-contract__check">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        patch({
                          chains: e.target.checked
                            ? [...form.chains, c.id]
                            : form.chains.filter((id) => id !== c.id),
                        })
                      }
                    />
                    <span>{c.name}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        </div>

        <div className="trd-contract__grid">
          <label className="trd-field">
            <span>{t('trading.contract.budgetTotal')}</span>
            <input
              className="mac-input trd-mono"
              inputMode="decimal"
              value={form.budgetTotalUsd}
              onChange={(e) => patch({ budgetTotalUsd: e.target.value })}
              data-testid="contract-budget"
            />
          </label>
          <label className="trd-field">
            <span>{t('trading.contract.budgetPerOrder')}</span>
            <input
              className="mac-input trd-mono"
              inputMode="decimal"
              value={form.budgetPerOrderUsd}
              onChange={(e) => patch({ budgetPerOrderUsd: e.target.value })}
            />
          </label>
        </div>
        {limits ? (
          <p className="trd-contract__limits" data-testid="engine-limits">
            {t('trading.contract.engineLimits')}
          </p>
        ) : null}

        {!oneShot ? (
          <>
            <div className="trd-contract__grid">
              <label className="trd-field">
                <span>{t('trading.contract.interval')}</span>
                <select
                  className="mac-input"
                  value={form.interval.kind === 'every' ? String(form.interval.seconds) : 'cron'}
                  onChange={(e) =>
                    patch({
                      interval:
                        e.target.value === 'cron'
                          ? { kind: 'cron', expr: '0 9 * * *' }
                          : { kind: 'every', seconds: Number(e.target.value) },
                    })
                  }
                  data-testid="contract-interval"
                >
                  {INTERVALS.map((i) => (
                    <option key={i.seconds} value={i.seconds}>
                      {t('trading.contract.every')} {i.label}
                    </option>
                  ))}
                  <option value="cron">{t('trading.contract.cron')}</option>
                </select>
              </label>
              {form.interval.kind === 'cron' ? (
                <label className="trd-field">
                  <span>{t('trading.contract.cronExpr')}</span>
                  <input
                    className="mac-input trd-mono"
                    value={form.interval.expr}
                    onChange={(e) => patch({ interval: { kind: 'cron', expr: e.target.value } })}
                  />
                </label>
              ) : (
                <label className="trd-field">
                  <span>{t('trading.contract.stop')}</span>
                  <select
                    className="mac-input"
                    value={form.stop.kind}
                    onChange={(e) => {
                      const k = e.target.value
                      patch({
                        stop:
                          k === 'until'
                            ? {
                                kind: 'until',
                                until: new Date(Date.now() + 7 * 86_400_000)
                                  .toISOString()
                                  .slice(0, 10),
                              }
                            : k === 'runs'
                              ? { kind: 'runs', runs: 10 }
                              : k === 'goal'
                                ? { kind: 'goal' }
                                : { kind: 'none' },
                      })
                    }}
                    data-testid="contract-stop"
                  >
                    <option value="none">{t('trading.contract.stop.none')}</option>
                    <option value="until">{t('trading.contract.stop.until')}</option>
                    <option value="runs">{t('trading.contract.stop.runs')}</option>
                    <option value="goal">{t('trading.contract.stop.goal')}</option>
                  </select>
                </label>
              )}
            </div>
            {form.stop.kind === 'until' ? (
              <label className="trd-field">
                <span>{t('trading.contract.stop.untilDate')}</span>
                <input
                  className="mac-input trd-mono"
                  type="date"
                  value={form.stop.until}
                  onChange={(e) => patch({ stop: { kind: 'until', until: e.target.value } })}
                />
              </label>
            ) : form.stop.kind === 'runs' ? (
              <label className="trd-field">
                <span>{t('trading.contract.stop.runCount')}</span>
                <input
                  className="mac-input trd-mono"
                  inputMode="numeric"
                  value={String(form.stop.runs)}
                  onChange={(e) => patch({ stop: { kind: 'runs', runs: Number(e.target.value) } })}
                />
              </label>
            ) : null}
            <label className="trd-contract__check">
              <input
                type="checkbox"
                checked={form.dryRun}
                onChange={(e) => patch({ dryRun: e.target.checked })}
                data-testid="contract-dryrun"
              />
              <span>{t('trading.contract.dryRun')}</span>
            </label>
          </>
        ) : null}

        <button
          type="button"
          className="trd-contract__toggle app-no-drag"
          aria-expanded={showPrompt}
          onClick={() => setShowPrompt((v) => !v)}
          data-testid="contract-preview-toggle"
        >
          <ChevronDown className="size-3.5" strokeWidth={2} aria-hidden data-open={showPrompt} />
          {t('trading.contract.preview')}
        </button>
        {showPrompt ? (
          <pre className="trd-contract__prompt" data-testid="contract-prompt">
            {prompt}
          </pre>
        ) : null}
      </div>
    </Sheet>
  )
}
