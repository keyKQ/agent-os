import { useEffect } from 'react'
import { ThemePicker } from '~/theme/ThemePicker'
import { t } from '~/i18n'
import { useSettings } from '~/stores/settings'

const MODES = ['managed', 'external'] as const

export function SettingsView() {
  const { settings, load, update } = useSettings()
  useEffect(() => void load(), [load])
  const gw = settings.gateway

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-7 px-6 py-4">
      <ThemePicker />

      <section aria-labelledby="gateway-heading">
        <h2 id="gateway-heading" className="mac-group-title">
          {t('settings.gateway.section')}
        </h2>
        <div className="mac-group">
          <div className="mac-group-row">
            <div>
              <div>{t('settings.gateway.mode')}</div>
              <div className="mac-help">{t('settings.gateway.mode.help')}</div>
            </div>
            <div
              role="radiogroup"
              aria-label={t('settings.gateway.mode')}
              className="mac-segmented"
            >
              {MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={gw.mode === mode}
                  className="mac-segment"
                  onClick={() => void update({ gateway: { mode } })}
                >
                  {t(`settings.gateway.mode.${mode}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="mac-group-row">
            <span>{t('settings.gateway.endpoint')}</span>
            <code className="text-xs text-muted-foreground">
              {gw.host}:{gw.port}
            </code>
          </div>
          <div className="mac-group-row">
            <span>{t('settings.gateway.cli')}</span>
            <code className="text-xs text-muted-foreground">
              {gw.cliPath ?? t('settings.gateway.cli.auto')}
            </code>
          </div>
        </div>
      </section>
    </div>
  )
}
