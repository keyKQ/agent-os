import { Check, Copy, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useWalletMutation } from '~/stores/trading'
import { errorText, shortAddress, walletLabel } from './logic'
import { Sheet } from './parts'
import type { UnlockMode, Wallet } from './types'

export type WalletSheetMode =
  | { kind: 'setup' }
  | { kind: 'unlock' }
  | { kind: 'create' }
  | { kind: 'import' }
  | { kind: 'rename'; wallet: Wallet }
  | { kind: 'export'; wallet: Wallet }
  | { kind: 'remove'; wallet: Wallet }

/**
 * Every write to the vault, one sheet each: create the vault, unlock it,
 * create or import a wallet, rename, export, remove. Secrets typed here
 * live in component state and are gone when the sheet closes.
 */
export function WalletSheet({ mode, onClose }: { mode: WalletSheetMode; onClose: () => void }) {
  switch (mode.kind) {
    case 'setup':
      return <SetupSheet onClose={onClose} />
    case 'unlock':
      return <UnlockSheet onClose={onClose} />
    case 'create':
      return <CreateSheet onClose={onClose} />
    case 'import':
      return <ImportSheet onClose={onClose} />
    case 'rename':
      return <RenameSheet wallet={mode.wallet} onClose={onClose} />
    case 'export':
      return <ExportSheet wallet={mode.wallet} onClose={onClose} />
    case 'remove':
      return <RemoveSheet wallet={mode.wallet} onClose={onClose} />
  }
}

function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id?: string
  label: string
  help?: string
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="trd-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <span className="trd-field__error">{error}</span>
      ) : help ? (
        <span className="trd-field__help">{help}</span>
      ) : null}
    </div>
  )
}

function SetupSheet({ onClose }: { onClose: () => void }) {
  const ids = { pw: useId(), pw2: useId() }
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [unlockMode, setUnlockMode] = useState<UnlockMode>('auto')
  const m = useWalletMutation()
  const short = pw.length > 0 && pw.length < 8
  const mismatch = pw2.length > 0 && pw !== pw2
  const ok = pw.length >= 8 && pw === pw2
  return (
    <Sheet
      title={t('trading.sheet.setup.title')}
      onClose={onClose}
      foot={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            {t('trading.sheet.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ok || m.isPending}
            data-testid="setup-submit"
            onClick={() =>
              m.mutate(
                { method: 'wallet.setup', params: { password: pw, unlockMode } },
                {
                  onSuccess: onClose,
                  onError: (err) => toast.error(`${t('trading.sheet.error')}: ${errorText(err)}`),
                },
              )
            }
          >
            {m.isPending ? t('trading.sheet.working') : t('trading.sheet.setup.cta')}
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-muted-foreground">{t('trading.setup.body')}</p>
      <Field
        id={ids.pw}
        label={t('trading.sheet.setup.password')}
        error={short ? t('trading.sheet.setup.short') : null}
      >
        <input
          id={ids.pw}
          className="mac-input"
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </Field>
      <Field
        id={ids.pw2}
        label={t('trading.sheet.setup.confirm')}
        error={mismatch ? t('trading.sheet.setup.mismatch') : null}
      >
        <input
          id={ids.pw2}
          className="mac-input"
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
      </Field>
      <div className="trd-field">
        <span className="trd-field__label">{t('trading.sheet.setup.mode')}</span>
        <div className="trd-choice" role="radiogroup" aria-label={t('trading.sheet.setup.mode')}>
          <label>
            <input
              type="radio"
              name="unlock"
              checked={unlockMode === 'auto'}
              onChange={() => setUnlockMode('auto')}
            />
            <b>{t('trading.sheet.setup.mode.auto')}</b>
            <span>{t('trading.sheet.setup.mode.auto.help')}</span>
          </label>
          <label>
            <input
              type="radio"
              name="unlock"
              checked={unlockMode === 'manual'}
              onChange={() => setUnlockMode('manual')}
            />
            <b>{t('trading.sheet.setup.mode.manual')}</b>
            <span>{t('trading.sheet.setup.mode.manual.help')}</span>
          </label>
        </div>
      </div>
    </Sheet>
  )
}

function UnlockSheet({ onClose }: { onClose: () => void }) {
  const id = useId()
  const [pw, setPw] = useState('')
  const [wrong, setWrong] = useState(false)
  const m = useWalletMutation()
  function submit() {
    setWrong(false)
    m.mutate(
      { method: 'wallet.unlock', params: { password: pw } },
      {
        onSuccess: onClose,
        onError: () => setWrong(true),
      },
    )
  }
  return (
    <Sheet
      title={t('trading.sheet.unlock.title')}
      onClose={onClose}
      foot={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            {t('trading.sheet.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!pw || m.isPending}
            onClick={submit}
            data-testid="unlock-submit"
          >
            {m.isPending ? t('trading.sheet.working') : t('trading.sheet.unlock.cta')}
          </Button>
        </>
      }
    >
      <Field
        id={id}
        label={t('trading.sheet.password')}
        error={wrong ? t('trading.sheet.unlock.wrong') : null}
      >
        <input
          id={id}
          className="mac-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={pw}
          data-invalid={wrong ? 'true' : undefined}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pw) submit()
          }}
        />
      </Field>
    </Sheet>
  )
}

function CreateSheet({ onClose }: { onClose: () => void }) {
  const id = useId()
  const [label, setLabel] = useState('')
  const m = useWalletMutation<{ wallet: Wallet }>()
  return (
    <Sheet
      title={t('trading.sheet.create.title')}
      onClose={onClose}
      foot={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            {t('trading.sheet.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={m.isPending}
            data-testid="create-submit"
            onClick={() =>
              m.mutate(
                {
                  method: 'wallet.create',
                  params: { label: label.trim() || t('trading.sheet.create.label.placeholder') },
                },
                {
                  onSuccess: (res) => {
                    toast.success(t('trading.sheet.create.done'), {
                      description: res?.wallet ? shortAddress(res.wallet.address) : undefined,
                    })
                    onClose()
                  },
                  onError: (err) => toast.error(`${t('trading.sheet.error')}: ${errorText(err)}`),
                },
              )
            }
          >
            {m.isPending ? t('trading.sheet.working') : t('trading.sheet.create.cta')}
          </Button>
        </>
      }
    >
      <Field id={id} label={t('trading.sheet.create.label')}>
        <input
          id={id}
          className="mac-input"
          autoFocus
          placeholder={t('trading.sheet.create.label.placeholder')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
    </Sheet>
  )
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const ids = { label: useId(), key: useId(), ks: useId(), kspw: useId() }
  const [kind, setKind] = useState<'key' | 'keystore'>('key')
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keystore, setKeystore] = useState('')
  const [ksPassword, setKsPassword] = useState('')
  const m = useWalletMutation<{ wallet: Wallet }>()
  const ready = kind === 'key' ? key.trim().length >= 64 : keystore.trim().length > 0
  return (
    <Sheet
      title={t('trading.sheet.import.title')}
      onClose={onClose}
      wide
      foot={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            {t('trading.sheet.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready || m.isPending}
            data-testid="import-submit"
            onClick={() =>
              m.mutate(
                {
                  method: 'wallet.import',
                  params:
                    kind === 'key'
                      ? { label: label.trim() || 'Imported', privateKey: key.trim() }
                      : {
                          label: label.trim() || 'Imported',
                          keystoreJson: keystore.trim(),
                          keystorePassword: ksPassword,
                        },
                },
                {
                  onSuccess: (res) => {
                    toast.success(t('trading.sheet.import.done'), {
                      description: res?.wallet ? shortAddress(res.wallet.address) : undefined,
                    })
                    onClose()
                  },
                  onError: (err) => toast.error(`${t('trading.sheet.error')}: ${errorText(err)}`),
                },
              )
            }
          >
            {m.isPending ? t('trading.sheet.working') : t('trading.sheet.import.cta')}
          </Button>
        </>
      }
    >
      <div className="trd-field">
        <span className="trd-field__label">{t('trading.sheet.import.kind')}</span>
        <div
          role="radiogroup"
          aria-label={t('trading.sheet.import.kind')}
          className="mac-segmented self-start"
        >
          <button
            type="button"
            role="radio"
            aria-checked={kind === 'key'}
            className="mac-segment"
            onClick={() => setKind('key')}
          >
            {t('trading.sheet.import.kind.key')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kind === 'keystore'}
            className="mac-segment"
            onClick={() => setKind('keystore')}
          >
            {t('trading.sheet.import.kind.keystore')}
          </button>
        </div>
      </div>
      <Field id={ids.label} label={t('trading.sheet.create.label')}>
        <input
          id={ids.label}
          className="mac-input"
          placeholder={t('trading.sheet.create.label.placeholder')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      {kind === 'key' ? (
        <Field
          id={ids.key}
          label={t('trading.sheet.import.key')}
          help={t('trading.sheet.import.key.help')}
        >
          <input
            id={ids.key}
            className="mac-input"
            data-mono="true"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      ) : (
        <>
          <Field id={ids.ks} label={t('trading.sheet.import.keystore')}>
            <textarea
              id={ids.ks}
              className="mac-textarea"
              data-mono="true"
              rows={5}
              spellCheck={false}
              placeholder='{"version":3,…}'
              value={keystore}
              onChange={(e) => setKeystore(e.target.value)}
            />
          </Field>
          <Field id={ids.kspw} label={t('trading.sheet.import.keystore.password')}>
            <input
              id={ids.kspw}
              className="mac-input"
              type="password"
              autoComplete="off"
              value={ksPassword}
              onChange={(e) => setKsPassword(e.target.value)}
            />
          </Field>
        </>
      )}
      <p className="trd-field__help">{t('trading.sheet.import.history')}</p>
    </Sheet>
  )
}

function RenameSheet({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const id = useId()
  const [label, setLabel] = useState(wallet.label)
  const m = useWalletMutation()
  return (
    <Sheet
      title={t('trading.sheet.rename.title')}
      onClose={onClose}
      foot={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            {t('trading.sheet.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!label.trim() || m.isPending}
            onClick={() =>
              m.mutate(
                {
                  method: 'wallet.rename',
                  params: { address: wallet.address, label: label.trim() },
                },
                {
                  onSuccess: onClose,
                  onError: (err) => toast.error(`${t('trading.sheet.error')}: ${errorText(err)}`),
                },
              )
            }
          >
            {t('trading.sheet.rename.cta')}
          </Button>
        </>
      }
    >
      <Field id={id} label={t('trading.sheet.create.label')}>
        <input
          id={id}
          className="mac-input"
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
    </Sheet>
  )
}

function ExportSheet({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const ids = { pw: useId() }
  const [format, setFormat] = useState<'keystore' | 'privateKey'>('keystore')
  const [pw, setPw] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const m = useWalletMutation<{ keystoreJson?: string; privateKey?: string }>()
  function reveal() {
    m.mutate(
      { method: 'wallet.export', params: { address: wallet.address, password: pw, format } },
      {
        onSuccess: (res) => {
          const value = res?.privateKey ?? res?.keystoreJson ?? null
          setSecret(value)
          setPw('')
        },
        onError: (err) => toast.error(`${t('trading.sheet.error')}: ${errorText(err)}`),
      },
    )
  }
  async function copy() {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      toast.success(t('trading.sheet.export.copied'), { id: 'trd-export' })
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <Sheet
      title={`${t('trading.sheet.export.title')} · ${walletLabel(wallet)}`}
      onClose={onClose}
      role="alertdialog"
      wide
      foot={
        secret ? (
          <>
            <Button onClick={() => setSecret(null)}>{t('trading.sheet.export.hide')}</Button>
            <Button variant="primary" onClick={() => void copy()} data-testid="export-copy">
              {copied ? (
                <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
              ) : (
                <Copy className="size-3.5" strokeWidth={1.75} aria-hidden />
              )}
              {t('trading.sheet.export.copy')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={m.isPending}>
              {t('trading.sheet.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={!pw || m.isPending}
              onClick={reveal}
              data-testid="export-reveal"
            >
              {m.isPending ? t('trading.sheet.working') : t('trading.sheet.export.cta')}
            </Button>
          </>
        )
      }
    >
      <div className="trd-warn" role="alert">
        <TriangleAlert className="size-3.5" strokeWidth={2} aria-hidden />
        <span>{t('trading.sheet.export.warning')}</span>
      </div>
      {secret ? (
        <pre className="trd-secret" data-testid="export-secret">
          {secret}
        </pre>
      ) : (
        <>
          <div className="trd-field">
            <span className="trd-field__label">{t('trading.sheet.export.format')}</span>
            <div
              role="radiogroup"
              aria-label={t('trading.sheet.export.format')}
              className="mac-segmented self-start"
            >
              <button
                type="button"
                role="radio"
                aria-checked={format === 'keystore'}
                className="mac-segment"
                onClick={() => setFormat('keystore')}
              >
                {t('trading.sheet.export.format.keystore')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={format === 'privateKey'}
                className="mac-segment"
                onClick={() => setFormat('privateKey')}
              >
                {t('trading.sheet.export.format.privateKey')}
              </button>
            </div>
          </div>
          <Field id={ids.pw} label={t('trading.sheet.export.password')}>
            <input
              id={ids.pw}
              className="mac-input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pw) reveal()
              }}
            />
          </Field>
        </>
      )}
    </Sheet>
  )
}

function RemoveSheet({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const id = useId()
  const [pw, setPw] = useState('')
  const m = useWalletMutation()
  return (
    <Sheet
      title={`${t('trading.sheet.remove.title')} · ${walletLabel(wallet)}`}
      onClose={onClose}
      role="alertdialog"
      foot={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            {t('trading.sheet.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!pw || m.isPending}
            data-testid="remove-submit"
            onClick={() =>
              m.mutate(
                { method: 'wallet.remove', params: { address: wallet.address, password: pw } },
                {
                  onSuccess: () => {
                    toast.success(t('trading.sheet.remove.done'))
                    onClose()
                  },
                  onError: (err) => toast.error(`${t('trading.sheet.error')}: ${errorText(err)}`),
                },
              )
            }
          >
            {m.isPending ? t('trading.sheet.working') : t('trading.sheet.remove.cta')}
          </Button>
        </>
      }
    >
      <div className="trd-warn" role="alert">
        <TriangleAlert className="size-3.5" strokeWidth={2} aria-hidden />
        <span>{t('trading.sheet.remove.body')}</span>
      </div>
      <p className="trd-mono text-[11.5px] text-muted-foreground">{wallet.address}</p>
      <Field id={id} label={t('trading.sheet.remove.password')}>
        <input
          id={id}
          className="mac-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </Field>
    </Sheet>
  )
}
