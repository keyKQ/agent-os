import { TEXT_SIZES } from '@shared/settings'
import { Switch } from '~/components/ui/switch'
import { t } from '~/i18n'
import { useSettings } from '~/stores/settings'
import { ThemePicker } from '~/theme/ThemePicker'
import { Group, Row, Segmented } from '../parts'

export function AppearancePane() {
  const appearance = useSettings((s) => s.settings.appearance)
  const update = useSettings((s) => s.update)

  return (
    <>
      <ThemePicker />

      <Group title={t('settings.appearance.window')}>
        <Row
          label={t('settings.appearance.textSize')}
          help={t('settings.appearance.textSize.help')}
        >
          <Segmented
            label={t('settings.appearance.textSize')}
            value={appearance.textSize}
            options={TEXT_SIZES.map((size) => ({
              value: size,
              label: t(`settings.appearance.textSize.${size}`),
            }))}
            onChange={(textSize) => void update({ appearance: { textSize } })}
          />
        </Row>
        <Row
          label={t('settings.appearance.reduceTransparency')}
          help={t('settings.appearance.reduceTransparency.help')}
        >
          <Switch
            checked={appearance.reduceTransparency}
            aria-label={t('settings.appearance.reduceTransparency')}
            onCheckedChange={(reduceTransparency) =>
              void update({ appearance: { reduceTransparency } })
            }
          />
        </Row>
      </Group>
    </>
  )
}
