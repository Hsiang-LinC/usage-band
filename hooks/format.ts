export const CACHE_TTL_MS = 60 * 60 * 1000

export type Level = 'ok' | 'warn' | 'bad' | 'none'
// session: ctx and cache; quota: 5h and 7d. The band separates the two groups.
// `action` is a button drawn after the segment (a Button cannot carry the
// segment's colours). A disabled action keeps its place, drawn dim and inert,
// so the band does not shift when the action comes and goes.
export type Segment = {
  text: string
  level: Level
  group: 'session' | 'quota'
  action?: { kind: 'compact' | 'warm'; label: string; isEnabled: boolean }
}

// Usage turns yellow at WARN_AT and red at BAD_AT; ctx is pressable (compact)
// from the first colour change on.
const WARN_AT = 50
const BAD_AT = 80
export const COMPACT_FROM = WARN_AT
// The Japanese hot-spring sign (U+2668). It is also an emoji, which some
// terminals draw two cells wide: the band gives it a fixed two-cell box.
export const WARM_SIGN = '♨'
// The cache segment turns yellow with this long left: a simple threshold, so
// nothing needs drawing at the moment it is crossed beyond the minute tick.
export const CACHE_WARN_MS = 20 * 60_000
// The warm sign is live (red, pressable) with less than this left; before that
// it is the same sign, uncoloured and inert.
export const WARM_FROM_MS = 30 * 60_000

type Usage = { input: number; cacheRead: number; cacheWrite: number }

export type LineInput = {
  contextPercent?: number
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  // Absent until a main-thread request has been sent.
  // Whether /compact can run now: it is refused while a request is in flight.
  canCompact?: boolean
  // Whether a keep-warm request can go now: nothing in flight, none just sent.
  canWarm?: boolean
  cache?: {
    // When the newest counted request was sent (ms): the TTL restarts when a
    // request reads or writes the cache, not when its response ends.
    sentAt: number
    // Figures of the newest request that answered; absent while none has.
    usage?: Usage
  }
  now: number
}

// Green <50, yellow <80, red after; shared by ctx and quota.
const byUsed = (pct: number): Level => (pct >= BAD_AT ? 'bad' : pct >= WARN_AT ? 'warn' : 'ok')

// "3d04h" / "2h13m" / "45m"
function duration(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${String(Math.floor((mins % 1440) / 60)).padStart(2, '0')}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}

// Time until the window resets; undefined once it already has.
function untilReset(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined
  const ms = Date.parse(resetsAt) - now
  return ms > 0 ? duration(ms) : undefined
}

const hitPercent = (u: Usage | undefined): number | undefined => {
  const total = u ? u.input + u.cacheRead + u.cacheWrite : 0
  return u && total > 0 ? Math.floor((u.cacheRead / total) * 100) : undefined
}

const WINDOW_MS = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 } as const
// Too little of a window has passed for its burn rate to say anything.
const MIN_ELAPSED = 0.1
// Pace ratio (1 is an even burn) under SLOW or over FAST is marked; between,
// the plain sign. A small square rather than `~` or `·` (the separator):
// it shares the triangles' size and weight. Before a pace exists, 5h shows a
// hollow dot of the same size.
const SLOW = 0.75
const FAST = 1.25
const paceSign = (ratio: number) => (ratio < SLOW ? '▾' : ratio > FAST ? '▴' : '▪')

// Used share over elapsed share of the window: 1 is an even burn.
function pace(kind: keyof typeof WINDOW_MS, percentUsed: number, resetsAt: string | undefined, now: number): number | undefined {
  if (resetsAt === undefined) return undefined
  const length = WINDOW_MS[kind]
  const left = Date.parse(resetsAt) - now
  const elapsed = length - left
  if (!(left > 0) || elapsed < length * MIN_ELAPSED) return undefined
  return percentUsed / 100 / (elapsed / length)
}

export function formatSegments(i: LineInput): Segment[] {
  const parts: Segment[] = []

  if (i.contextPercent !== undefined) {
    const pct = Math.floor(i.contextPercent)
    const level = byUsed(pct)
    // the segment itself is the button; the band draws it pressable
    const action = i.canCompact && pct >= COMPACT_FROM ? { kind: 'compact' as const, label: 'compact', isEnabled: true } : undefined
    parts.push({ text: `ctx ${pct}%`, level, group: 'session', ...(action && { action }) })
  }

  const c = i.cache
  // always drawn: live only for a warm cache under 30 minutes, with an idle session
  const warm = (isEnabled: boolean) => ({ kind: 'warm' as const, label: WARM_SIGN, isEnabled })
  if (c === undefined) {
    parts.push({ text: 'cache --', level: 'none', group: 'session', action: warm(false) })
  } else {
    const remaining = c.sentAt + CACHE_TTL_MS - i.now
    if (remaining <= 0) {
      parts.push({ text: 'cache cold', level: 'bad', group: 'session', action: warm(false) })
    } else {
      const text =
        remaining < 60_000 ? 'cache <1m' : `cache ${Math.floor(remaining / 60_000)}m`
      const level: Level = remaining > CACHE_WARN_MS ? 'ok' : 'warn'
      parts.push({
        text,
        level,
        group: 'session',
        action: warm(i.canWarm === true && remaining < WARM_FROM_MS),
      })
      const hit = hitPercent(c.usage)
      if (hit !== undefined) parts.push({ text: `hit ${hit}%`, level, group: 'session' })
    }
  }

  for (const [kind, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const w = i.rateLimits.find(r => r.kind === kind)
    if (w) {
      const pct = Math.floor(w.percentUsed)
      const reset = untilReset(w.resetsAt, i.now)
      const p = pace(kind, w.percentUsed, w.resetsAt, i.now)
      // the sign says how fast the window is being used; with no pace yet the
      // 5h window shows the plain reset sign. 7d shows no reset time.
      const sign = p !== undefined ? paceSign(p) : kind === 'five_hour' && reset ? '◦' : ''
      parts.push({
        text: [`${label} ${pct}%`, sign, kind === 'five_hour' ? reset : undefined].filter(part => part !== undefined && part !== '').join(' '),
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
