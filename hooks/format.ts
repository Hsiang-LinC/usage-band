export const CACHE_TTL_MS = 60 * 60 * 1000

export type Level = 'ok' | 'warn' | 'bad' | 'none'
export type Segment = { text: string; level: Level }

export type LineInput = {
  contextPercent?: number
  rateLimits: { kind: string; percentUsed: number }[]
  // Last counted turn: its cache figures and when it ended (ms).
  lastTurn?: {
    endedAt: number
    input: number
    cacheRead: number
    cacheWrite: number
  }
  now: number
}

// Green <50, yellow <80, red after; shared by ctx and quota.
const byUsed = (pct: number): Level => (pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : 'ok')

export function formatSegments(i: LineInput): Segment[] {
  const parts: Segment[] = []

  if (i.contextPercent !== undefined) {
    const pct = Math.floor(i.contextPercent)
    const level = byUsed(pct)
    const hint = level === 'bad' ? ' → /compact or hand off' : ''
    parts.push({ text: `ctx ${pct}%${hint}`, level })
  }

  const t = i.lastTurn
  if (t === undefined) {
    parts.push({ text: 'cache --', level: 'none' })
  } else {
    const total = t.input + t.cacheRead + t.cacheWrite
    const remaining = t.endedAt + CACHE_TTL_MS - i.now
    const hit = total > 0 ? ` hit ${Math.floor((t.cacheRead / total) * 100)}%` : ''
    if (remaining <= 0) {
      parts.push({ text: 'cache cold' + hit, level: 'bad' })
    } else {
      const text =
        remaining < 60_000 ? 'cache <1m' : `cache ${Math.floor(remaining / 60_000)}m`
      const level: Level = remaining > 5 * 60_000 ? 'ok' : 'warn'
      parts.push({ text: text + hit, level })
    }
  }

  for (const [kind, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const w = i.rateLimits.find(r => r.kind === kind)
    if (w) {
      const pct = Math.floor(w.percentUsed)
      parts.push({ text: `${label} ${pct}%`, level: byUsed(pct) })
    }
  }

  return parts
}

export function formatLine(i: LineInput): string {
  return formatSegments(i)
    .map(s => s.text)
    .join(' · ')
}
