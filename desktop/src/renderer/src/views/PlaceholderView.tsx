import type { LucideIcon } from 'lucide-react'
import { EmptyState } from '~/components/EmptyState'
import { t, type MessageKey } from '~/i18n'

/** Shared shell for sections whose feature work has not landed. */
export function PlaceholderView({
  icon,
  title,
  body,
}: {
  icon: LucideIcon
  title: MessageKey
  body: MessageKey
}) {
  return <EmptyState icon={icon} title={t(title)} body={t(body)} />
}
