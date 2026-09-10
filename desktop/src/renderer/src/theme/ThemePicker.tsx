import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { PALETTE_IDS, THEME_PREFERENCES, type PaletteId, type ThemePreference } from '@shared/theme'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { PALETTES } from './palettes'
import { useTheme } from './theme-store'

const MODE_ICON: Record<ThemePreference, LucideIcon> = { system: Monitor, light: Sun, dark: Moon }

/** Appearance group for Settings, laid out like System Settings > Appearance. */
export function ThemePicker() {
  const { preference, palette, resolved, setPreference, setPalette } = useTheme()

  return (
    <section aria-labelledby="theme-heading">
      <h2 id="theme-heading" className="mac-group-title">
        {t('theme.section')}
      </h2>
      <div className="mac-group">
        <div className="mac-group-row">
          <div>
            <div>{t('theme.mode')}</div>
            <div className="mac-help">{t(`theme.resolved.${resolved}`)}</div>
          </div>
          <div role="radiogroup" aria-label={t('theme.mode')} className="mac-segmented">
            {THEME_PREFERENCES.map((mode) => {
              const Icon = MODE_ICON[mode]
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={mode === preference}
                  className="mac-segment"
                  onClick={() => void setPreference(mode)}
                >
                  <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
                  {t(`theme.mode.${mode}`)}
                </button>
              )
            })}
          </div>
        </div>
        <div className="mac-group-row items-start">
          <div className="pt-1.5">
            <div>{t('theme.palette')}</div>
            <div className="mac-help">{t('theme.palette.help')}</div>
          </div>
          <div role="radiogroup" aria-label={t('theme.palette')} className="flex gap-3">
            {PALETTE_IDS.map((id) => (
              <PaletteSwatch
                key={id}
                id={id}
                active={id === palette}
                onSelect={() => void setPalette(id)}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/** Wallpaper-thumbnail style selector: a miniature window in that palette. */
function PaletteSwatch({
  id,
  active,
  onSelect,
}: {
  id: PaletteId
  active: boolean
  onSelect(): void
}) {
  const def = PALETTES[id]
  const resolved = useTheme((s) => s.resolved)
  const c = def[resolved]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={def.label}
      title={def.description}
      onClick={onSelect}
      className="group flex w-28 flex-col items-center gap-1.5 outline-none"
    >
      <span
        className={cn(
          'relative flex h-16 w-full overflow-hidden rounded-md transition-shadow',
          'ring-1 ring-hairline group-focus-visible:ring-2 group-focus-visible:ring-ring',
          active && 'ring-2 ring-primary',
        )}
        style={{ background: c.background }}
        aria-hidden
      >
        <span className="h-full w-1/3" style={{ background: c.sidebar }}>
          <span
            className="mt-2 ml-1.5 block h-1.5 w-5 rounded-pill"
            style={{ background: c.muted }}
          />
          <span
            className="mt-1 ml-1.5 block h-1.5 w-6 rounded-pill"
            style={{ background: c['sidebar-accent'] }}
          />
        </span>
        <span className="flex flex-1 flex-col gap-1 p-2">
          <span
            className="h-1.5 w-8 rounded-pill"
            style={{ background: c.foreground, opacity: 0.6 }}
          />
          <span className="h-1.5 w-12 rounded-pill" style={{ background: c.muted }} />
          <span className="mt-auto h-3 w-8 rounded-[3px]" style={{ background: c.primary }} />
        </span>
        {active ? (
          <span
            className="absolute right-1 bottom-1 flex size-4 items-center justify-center rounded-pill"
            style={{ background: c.primary, color: c['primary-foreground'] }}
          >
            <Check className="size-3" strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className={cn('text-[11px]', active ? 'font-medium' : 'text-muted-foreground')}>
        {def.label}
      </span>
    </button>
  )
}
