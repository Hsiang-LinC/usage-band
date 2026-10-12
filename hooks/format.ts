export const CACHE_TTL_MS = 60 * 60 * 1000

export type Level = 'ok' | 'warn' | 'bad' | 'none'
// session: ctx and cache; quota: 5h and 7d. The band separates the two groups.
// `action` is a button drawn after the segment (a Button cannot carry the
// segment's colours).
export type Segment = {
  text: string
  level: Level
  group: 'session' | 'quota'
  action?: { kind: 'compact' | 'warm'; label: string }
}

// From this context share on, an idle session is offered the compact button.
export const COMPACT_FROM = 30

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
const byUsed = (pct: number): Level => (pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : 'ok')

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
// Pace ratio (1 is an even burn) to the arrow that shows it, slowest first.
const PACE_ARROWS = [
  [0.5, '↓'],
  [0.75, '↘'],
  [1.25, '→'],
  [2, '↗'],
  [Infinity, '↑'],
] as const
const paceArrow = (ratio: number) => PACE_ARROWS.find(([below]) => ratio < below || below === Infinity)![1]

type Pace = {
  // used share over elapsed share of the window: 1 is an even burn
  ratio: number
  // ms until 100% at the burn so far, when that comes before the reset
  fullIn?: number
}

function pace(kind: keyof typeof WINDOW_MS, percentUsed: number, resetsAt: string | undefined, now: number): Pace | undefined {
  if (resetsAt === undefined) return undefined
  const length = WINDOW_MS[kind]
  const left = Date.parse(resetsAt) - now
  const elapsed = length - left
  if (!(left > 0) || elapsed < length * MIN_ELAPSED) return undefined
  const used = percentUsed / 100
  const ratio = used / (elapsed / length)
  if (used <= 0 || used >= 1) return { ratio }
  // whole minutes, so float noise never moves a displayed minute
  const fullIn = Math.round(((1 - used) / (used / elapsed)) / 60_000) * 60_000
  return { ratio, fullIn: fullIn < left ? fullIn : undefined }
}

export function formatSegments(i: LineInput): Segment[] {
  const parts: Segment[] = []

  if (i.contextPercent !== undefined) {
    const pct = Math.floor(i.contextPercent)
    const level = byUsed(pct)
    if (i.canCompact && pct >= COMPACT_FROM) {
      const label = level === 'bad' ? '→ compact or hand off' : '→ compact'
      parts.push({ text: `ctx ${pct}%`, level, group: 'session', action: { kind: 'compact', label } })
    } else {
      const hint = level === 'bad' ? ' → /compact or hand off' : ''
      parts.push({ text: `ctx ${pct}%${hint}`, level, group: 'session' })
    }
  }

  const c = i.cache
  if (c === undefined) {
    parts.push({ text: 'cache --', level: 'none', group: 'session' })
  } else {
    const remaining = c.sentAt + CACHE_TTL_MS - i.now
    if (remaining <= 0) {
      parts.push({ text: 'cache cold', level: 'bad', group: 'session' })
    } else {
      const text =
        remaining < 60_000 ? 'cache <1m' : `cache ${Math.floor(remaining / 60_000)}m`
      const level: Level = remaining > 5 * 60_000 ? 'ok' : 'warn'
      parts.push({
        text,
        level,
        group: 'session',
        action: i.canWarm ? { kind: 'warm', label: '→ warm' } : undefined,
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
      // the arrow says how fast the window is being used; with no pace yet the
      // 5h window keeps the plain reset sign, and 7d shows nothing
      const sign = p !== undefined ? paceArrow(p.ratio) : kind === 'five_hour' && reset ? '↻' : ''
      const base = byUsed(pct)
      parts.push({
        text: [
          `${label} ${pct}%`,
          sign,
          kind === 'five_hour' ? reset : undefined,
          p?.fullIn === undefined ? undefined : `full in ${duration(p.fullIn)}`,
        ].filter(part => part !== undefined && part !== '').join(' '),
        // running out before the reset is worth a yellow even while the share is low
        level: p?.fullIn !== undefined && base === 'ok' ? 'warn' : base,
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
