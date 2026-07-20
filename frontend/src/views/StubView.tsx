import { useEffect } from 'react'
import { AsciiField } from '@/components/AsciiField'

export function StubView({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} - AgentOS Control`
  }, [title])
  return (
    <div>
      <header className="relative pt-4 pb-6">
        <AsciiField />
        <div className="relative">
          <div className="t-label">Control · {title}</div>
          <h2 className="t-display mt-1.5">{title}</h2>
        </div>
      </header>
      <div className="panel">
        <div className="panel__head">Status</div>
        <div className="panel__body text-sm text-dim">Migration pending (see parity matrix).</div>
      </div>
    </div>
  )
}
