export const CACHE_TTL_MS = 60 * 60 * 1000

export type Level = 'ok' | 'warn' | 'bad' | 'none'
// session: ctx and cache; quota: 5h and 7d. The band separates the two groups.
export type Segment = { text: string; level: Level; group: 'session' | 'quota' }

export type LineInput = {
  contextPercent?: number
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  // Absent until a main-thread request has been sent.
  cache?: {
    // When the newest counted request was sent (ms): the TTL restarts when a
    // request reads or writes the cache, not when its response ends.
    sentAt: number
    // Figures of the newest request that answered; absent while none has.
    usage?: { input: number; cacheRead: number; cacheWrite: number }
  }
  now: number
}

// Green <50, yellow <80, red after; shared by ctx and quota.
const byUsed = (pct: number): Level => (pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : 'ok')

// "2h13m" / "45m"; undefined once the window has already reset.
function untilReset(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return undefined
  const mins = Math.max(1, Math.floor(ms / 60_000))
  return mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}

export function formatSegments(i: LineInput): Segment[] {
  const parts: Segment[] = []

  if (i.contextPercent !== undefined) {
    const pct = Math.floor(i.contextPercent)
    const level = byUsed(pct)
    const hint = level === 'bad' ? ' → /compact or hand off' : ''
    parts.push({ text: `ctx ${pct}%${hint}`, level, group: 'session' })
  }

  const c = i.cache
  if (c === undefined) {
    parts.push({ text: 'cache --', level: 'none', group: 'session' })
  } else {
    const u = c.usage
    const total = u ? u.input + u.cacheRead + u.cacheWrite : 0
    const remaining = c.sentAt + CACHE_TTL_MS - i.now
    const hit = u && total > 0 ? ` · hit ${Math.floor((u.cacheRead / total) * 100)}%` : ''
    if (remaining <= 0) {
      parts.push({ text: 'cache cold', level: 'bad', group: 'session' })
    } else {
      const text =
        remaining < 60_000 ? 'cache <1m' : `cache ${Math.floor(remaining / 60_000)}m`
      const level: Level = remaining > 5 * 60_000 ? 'ok' : 'warn'
      parts.push({ text: text + hit, level, group: 'session' })
    }
  }

  for (const [kind, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const w = i.rateLimits.find(r => r.kind === kind)
    if (w) {
      const pct = Math.floor(w.percentUsed)
      const reset = kind === 'five_hour' ? untilReset(w.resetsAt, i.now) : undefined
      parts.push({
        text: `${label} ${pct}%${reset ? ` ↻ ${reset}` : ''}`,
        level: byUsed(pct),
        group: 'quota',
      })
    }
  }

  return parts
}

export function formatLine(i: LineInput): string {
  return formatSegments(i)
    .map(s => s.text)
    .join(' · ')
}
