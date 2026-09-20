import { ChevronDown, SendHorizontal, Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useSend, type SendRecipient } from '~/stores/trading'
import { errorText, sameAddress, walletLabel } from '../logic'
import { Sheet } from '../parts'
import { CHAINS, type Wallet } from '../types'
import {
  composeSendPrompt,
  parseRecipientLines,
  validateSend,
  type SendForm,
  type SendRecipientForm,
} from './desk-logic'

const ARM_RESET_MS = 4000

function linesOf(rows: readonly SendRecipientForm[]): string {
  return rows.map((r) => (r.amount ? `${r.address}=${r.amount}` : r.address)).join('\n')
}

/**
 * Send one token to one or many addresses. Two ways out, on purpose:
 * "Ask the desk" posts an exact prompt into the chat, the agent runs one
 * `agentos trade send`, and the batch comes back here as a card for your
 * approval — the path that leaves a record of the reasoning. "Send now"
 * signs and broadcasts as you, immediately, and arms first because a send
 * cannot be undone.
 */
export function SendSheet({
  wallets,
  primary,
  multi = false,
  onClose,
  onAsk,
}: {
  wallets: readonly Wallet[]
  primary: string | null
  /** Opened as "Multisend": the recipients box leads and says so. */
  multi?: boolean
  onClose: () => void
  /** Post the composed prompt into the desk chat. */
  onAsk: (prompt: string) => void
}) {
  const [form, setForm] = useState<SendForm>({
    chainId: 8453,
    wallet: primary,
    token: '',
    recipients: [],
    amount: '',
    usd: '',
    note: '',
  })
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [armed, setArmed] = useState(false)
  const send = useSend()

  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(false), ARM_RESET_MS)
    return () => window.clearTimeout(id)
  }, [armed])

  const patch = (p: Partial<SendForm>) => {
    setTouched(true)
    setForm((f) => ({ ...f, ...p }))
  }
  const onRecipients = (value: string) => {
    setText(value)
    patch({ recipients: parseRecipientLines(value) })
  }
  const check = validateSend(form)
  const prompt = useMemo(() => composeSendPrompt(form, { wallets }), [form, wallets])
  const count = form.recipients.filter((r) => r.address.trim()).length
  const walletRow =
    wallets.find((w) => sameAddress(w.address, form.wallet)) ??
    wallets.find((w) => w.primary) ??
    wallets[0] ??
    null

  function ask() {
    setTouched(true)
    if (!check.ok) return
    onAsk(prompt)
  }

  function sendNow() {
    setTouched(true)
    if (!check.ok) return
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    const recipients: SendRecipient[] = form.recipients
      .filter((r) => r.address.trim())
      .map((r) => {
        const own = r.amount.trim()
        if (own) return { to: r.address.trim(), amount: own }
        if (form.amount.trim()) return { to: r.address.trim(), amount: form.amount.trim() }
        return { to: r.address.trim(), amountUsd: Number(form.usd) }
      })
    send.mutate(
      {
        chainId: form.chainId,
        ...(walletRow ? { wallet: walletRow.address } : {}),
        token: form.token.trim(),
        recipients,
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
      },
      {
        onSuccess: (res) => {
          const failed = res.orders.filter((o) => o.status === 'failed')
          if (failed.length === res.orders.length && failed[0]) {
            toast.error(`${t('trading.send.failed')}: ${failed[0].reason ?? ''}`, {
              id: 'trd-send',
            })
            return
          }
          toast.success(t('trading.send.sent'), {
            id: 'trd-send',
            description: t('trading.send.sent.body'),
          })
          onClose()
        },
        onError: (err) =>
          toast.error(`${t('trading.send.failed')}: ${errorText(err)}`, { id: 'trd-send' }),
      },
    )
  }

  const error = touched && !check.ok ? check.error : undefined

  return (
    <Sheet
      title={multi ? t('trading.tool.multisend.name') : t('trading.send.title')}
      onClose={onClose}
      wide
      note={
        <span className="trd-send__warn">
          <TriangleAlert className="size-3" strokeWidth={2} aria-hidden />
          {t('trading.send.irreversible')}
        </span>
      }
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('trading.sheet.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={send.isPending}
            onClick={sendNow}
            data-armed={armed || undefined}
            title={t('trading.send.now.help')}
            data-testid="send-now"
          >
            <SendHorizontal className="size-3.5" strokeWidth={2} aria-hidden />
            {send.isPending
              ? t('trading.send.sending')
              : armed
                ? t('trading.send.now.confirm')
                : t('trading.send.now')}
          </Button>
          <Button
            variant="primary"
            disabled={send.isPending}
            onClick={ask}
            title={t('trading.send.ask.help')}
            data-testid="send-ask"
          >
            <Sparkles className="size-3.5" strokeWidth={2} aria-hidden />
            {t('trading.send.ask')}
          </Button>
        </>
      }
    >
      <div className="trd-send" data-testid="send-sheet">
        <div className="trd-send__row">
          <label className="trd-send__field">
            <span>{t('trading.send.chain')}</span>
            <select
              className="mac-input"
              value={form.chainId}
              onChange={(e) => patch({ chainId: Number(e.target.value) })}
              data-testid="send-chain"
            >
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="trd-send__field">
            <span>{t('trading.send.wallet')}</span>
            <select
              className="mac-input"
              value={walletRow?.address ?? ''}
              onChange={(e) => patch({ wallet: e.target.value })}
              data-testid="send-wallet"
            >
              {wallets.map((w) => (
                <option key={w.address} value={w.address}>
                  {walletLabel(w)}
                </option>
              ))}
            </select>
          </label>
          <label className="trd-send__field" data-error={error === 'token' || undefined}>
            <span>{t('trading.send.token')}</span>
            <input
              className="mac-input"
              value={form.token}
              placeholder={t('trading.send.token.placeholder')}
              onChange={(e) => patch({ token: e.target.value })}
              data-testid="send-token"
            />
          </label>
        </div>

        <label
          className="trd-send__field"
          data-error={
            error === 'recipients' || error === 'address' || error === 'duplicate' || undefined
          }
        >
          <span>
            {t('trading.send.recipients')}
            {count ? (
              <em className="trd-send__count">
                {count} {t('trading.send.count')}
              </em>
            ) : null}
          </span>
          <textarea
            className="mac-input trd-send__list trd-mono"
            rows={Math.min(12, Math.max(multi ? 6 : 3, count + 1))}
            autoFocus={multi}
            value={text}
            placeholder={t('trading.send.recipients.placeholder')}
            onChange={(e) => onRecipients(e.target.value)}
            onBlur={() => {
              // Normalise what was pasted so the preview and the send agree.
              if (form.recipients.length) setText(linesOf(form.recipients))
            }}
            spellCheck={false}
            data-testid="send-recipients"
          />
          <small>{t('trading.send.recipients.help')}</small>
        </label>

        <div className="trd-send__row">
          <label className="trd-send__field" data-error={error === 'amount' || undefined}>
            <span>{t('trading.send.amount')}</span>
            <input
              className="mac-input trd-num"
              inputMode="decimal"
              value={form.amount}
              placeholder="0"
              onChange={(e) => patch({ amount: e.target.value, usd: '' })}
              data-testid="send-amount"
            />
          </label>
          <label className="trd-send__field" data-error={error === 'amount' || undefined}>
            <span>{t('trading.send.usd')}</span>
            <input
              className="mac-input trd-num"
              inputMode="decimal"
              value={form.usd}
              placeholder="0"
              onChange={(e) => patch({ usd: e.target.value, amount: '' })}
              data-testid="send-usd"
            />
          </label>
          <label className="trd-send__field trd-send__field--wide">
            <span>{t('trading.send.note')}</span>
            <input
              className="mac-input"
              value={form.note}
              placeholder={t('trading.send.note.placeholder')}
              onChange={(e) => patch({ note: e.target.value })}
              data-testid="send-note"
            />
          </label>
        </div>

        {error ? (
          <p className="trd-send__error" role="alert" data-testid="send-error">
            {t(`trading.send.error.${error}`)}
          </p>
        ) : null}

        <button
          type="button"
          className="trd-send__toggle app-no-drag"
          onClick={() => setShowPrompt((v) => !v)}
          aria-expanded={showPrompt}
          data-testid="send-preview-toggle"
        >
          <ChevronDown
            className="size-3"
            strokeWidth={2}
            aria-hidden
            style={{ rotate: showPrompt ? '180deg' : '0deg' }}
          />
          {t('trading.send.preview')}
        </button>
        {showPrompt ? (
          <pre className="trd-send__prompt trd-mono" data-testid="send-preview">
            {prompt}
          </pre>
        ) : null}
      </div>
    </Sheet>
  )
}
