import './pet.css'
import { useEffect, useRef, useState } from 'react'
import { useRpc } from '@/app/providers'
import {
  PET_FRAME_H,
  PET_FRAME_W,
  PET_FRAMES_PER_STATE,
  PET_LOOP_MS,
  petSheetUrl,
  petStateRow,
  sheetGeometry,
  type SheetGeometry,
} from '@shared/pet'
import { useSettings } from '~/stores/settings'
import { bindPetSignals, usePet } from '~/stores/pet'

const POS_KEY = 'agentos-desktop.petPosition'

interface Pos {
  x: number
  y: number
}

function loadPos(): Pos | null {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) return { x: raw.x, y: raw.y }
  } catch {
    /* storage unavailable */
  }
  return null
}

function savePos(pos: Pos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    /* storage unavailable */
  }
}

/**
 * The petdex mascot floating over the window: one sheet, one row per state,
 * six frames stepped by CSS the way the petdex web app animates. Drag it
 * anywhere (the spot is remembered); click it and it waves back.
 */
export function PetOverlay() {
  const rpc = useRpc()
  const pet = useSettings((s) => s.settings.pet)
  useEffect(() => bindPetSignals(rpc), [rpc])
  if (!pet.enabled || !pet.slug) return null
  return <PetSprite slug={pet.slug} scale={pet.scale} />
}

function PetSprite({ slug, scale }: { slug: string; scale: number }) {
  const state = usePet((s) => s.state)
  const poke = usePet((s) => s.poke)
  const [geometry, setGeometry] = useState<SheetGeometry | null>(null)
  const [pos, setPos] = useState<Pos | null>(loadPos)
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  const url = petSheetUrl(slug)

  // Measure the sheet once per pet: the grid tells us which rows exist.
  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setGeometry(sheetGeometry(img.naturalWidth, img.naturalHeight))
    }
    img.onerror = () => {
      if (!cancelled) setGeometry(null)
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  if (!geometry) return null
  const w = PET_FRAME_W * scale
  const h = PET_FRAME_H * scale
  const row = petStateRow(state, geometry.rows)
  const style: React.CSSProperties = {
    width: w,
    height: h,
    backgroundImage: `url("${url}")`,
    backgroundSize: `${geometry.cols * w}px ${geometry.rows * h}px`,
    backgroundPositionY: `${-row * h}px`,
    ['--pet-frame-w' as string]: `${w}px`,
    ['--pet-frames' as string]: String(PET_FRAMES_PER_STATE),
    ['--pet-loop' as string]: `${PET_LOOP_MS}ms`,
    ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : {}),
  }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!drag.current) return
    const x = Math.max(0, Math.min(window.innerWidth - w, e.clientX - drag.current.dx))
    const y = Math.max(0, Math.min(window.innerHeight - h, e.clientY - drag.current.dy))
    drag.current.moved = true
    setPos({ x, y })
  }
  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (d?.moved && pos) savePos(pos)
    else if (!d?.moved) poke()
  }

  return (
    <button
      type="button"
      className="pet app-no-drag"
      data-state={state}
      aria-label={`Pet: ${state}`}
      title={slug}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null
      }}
    />
  )
}
