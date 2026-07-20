// Atmospheric ASCII field (decorative). Deterministic seeded pattern so the
// texture is stable across renders and themes; density thins toward the top
// like drifting embers. Colors come from the token system (signal-tinted).
const GLYPHS = ['^', '*', '+', 'x', '·', '"', "'"] as const

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildField(rows: number, cols: number, seed: number): string {
  const rand = mulberry32(seed)
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    // Density ramps up toward the bottom rows (ember drift).
    const density = 0.04 + (r / rows) * 0.3
    let line = ''
    for (let c = 0; c < cols; c++) {
      line += rand() < density ? GLYPHS[Math.floor(rand() * GLYPHS.length)] : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const FIELD = buildField(9, 220, 20260720)

export function AsciiField() {
  return (
    <div className="ascii-field" aria-hidden="true">
      {FIELD}
    </div>
  )
}
