import './pet.css'
import { useEffect, useRef, useState } from 'react'
import { useRpc } from '@/app/providers'
import {
  PET_FRAME_H,
  PET_FRAME_W,
  PET_LOOP_MS,
  petSheetUrl,
  petStateRow,
  rowFrameCounts,
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

interface Sheet extends SheetGeometry {
  /** Real frames per row (see rowFrameCounts). */
  frames: number[]
  /** The pixels could not be read; every row runs the full stride. */
  tainted?: boolean
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

/** Alpha threshold at or below which a frame counts as transparent padding. */
const BLANK_ALPHA = 8
/** Sample every Nth pixel: enough to catch any sprite, cheap on an 11-row sheet. */
const SAMPLE_STRIDE = 4

/**
 * Decode the sheet once and measure which frames of each row are real.
 * Runs off the loaded <img> on a scratch canvas; a decode failure leaves
 * every row at the full stride, which is what the petdex web app does.
 */
function measureSheet(img: HTMLImageElement): Sheet | null {
  const geometry = sheetGeometry(img.naturalWidth, img.naturalHeight)
  if (!geometry) return null
  const full = Array.from({ length: geometry.rows }, () => 6)
  let tainted = false
  try {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return { ...geometry, frames: full }
    ctx.drawImage(img, 0, 0)
    const isBlank = (col: number, row: number) => {
      const data = ctx.getImageData(col * PET_FRAME_W, row * PET_FRAME_H, PET_FRAME_W, PET_FRAME_H)
      for (let y = 0; y < PET_FRAME_H; y += SAMPLE_STRIDE) {
        for (let x = 0; x < PET_FRAME_W; x += SAMPLE_STRIDE) {
          if (data.data[(y * PET_FRAME_W + x) * 4 + 3]! > BLANK_ALPHA) return false
        }
      }
      return true
    }
    return { ...geometry, frames: rowFrameCounts(geometry, isBlank) }
  } catch (err) {
    tainted = true
    console.warn('[pet] could not measure sheet frames', err)
    return { ...geometry, frames: full, tainted }
  }
}

/**
 * The petdex mascot floating over the window: one sheet, one row per state,
 * the row's real frames stepped by CSS the way the petdex web app animates.
 * Drag it anywhere (the spot is remembered); click it and it waves back.
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
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [pos, setPos] = useState<Pos | null>(loadPos)
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  const url = petSheetUrl(slug)

  // Measure the sheet once per pet: the grid says which rows exist, the
  // alpha says how many frames each row really has.
  useEffect(() => {
    let cancelled = false
    const img = new Image()
    // Needed to read pixels back in measureSheet; the pet scheme allows it.
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (!cancelled) setSheet(measureSheet(img))
    }
    img.onerror = () => {
      if (!cancelled) setSheet(null)
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  if (!sheet) return null
  // Whole pixels: a fractional frame width puts every step on a sub-pixel
  // boundary and the sprite shimmers.
  const w = Math.max(1, Math.round(PET_FRAME_W * scale))
  const h = Math.max(1, Math.round(PET_FRAME_H * scale))
  const row = petStateRow(state, sheet.rows)
  const frames = sheet.frames[row] ?? 1
  const style: React.CSSProperties = {
    width: w,
    height: h,
    backgroundImage: `url("${url}")`,
    backgroundSize: `${sheet.cols * w}px ${sheet.rows * h}px`,
    backgroundPositionY: `${-row * h}px`,
    ['--pet-frame-w' as string]: `${w}px`,
    ['--pet-frames' as string]: String(frames),
    ['--pet-loop' as string]: `${Math.round((PET_LOOP_MS * frames) / 6)}ms`,
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
      // A new row restarts the walk from its first frame, as Hermes does.
      key={row}
      type="button"
      className="pet app-no-drag"
      data-state={state}
      data-frames={frames}
      data-measured={sheet.tainted ? 'false' : 'true'}
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
