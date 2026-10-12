export const CACHE_TTL_MS = 60 * 60 * 1000

export type Level = 'ok' | 'warn' | 'bad' | 'none'
// session: ctx and cache; quota: 5h and 7d. The band separates the two groups.
// Pressable when it has either: `detail` is shown on press, `action` is run.
export type Segment = {
  text: string
  level: Level
  group: 'session' | 'quota'
  detail?: string
  action?: 'compact'
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
  cache?: {
    // When the newest counted request was sent (ms): the TTL restarts when a
    // request reads or writes the cache, not when its response ends.
    sentAt: number
    // Figures of the newest request that answered; absent while none has.
    usage?: Usage
    // Sum over every answered main-thread request, for the hit detail.
    total?: Usage
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
const AHEAD = 1.25
const BEHIND = 0.75

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
      const handOff = level === 'bad' ? ' or hand off' : ''
      parts.push({ text: `ctx ${pct}% → compact${handOff}`, level, group: 'session', action: 'compact' })
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
      parts.push({ text, level, group: 'session' })
      const hit = hitPercent(c.usage)
      if (hit !== undefined && c.usage) {
        const u = c.usage
        const all = hitPercent(c.total)
        parts.push({
          text: `hit ${hit}%`,
          level,
          group: 'session',
          detail: `hit ${hit}% on the newest request (read ${u.cacheRead} · written ${u.cacheWrite} · uncached ${u.input} tokens)${all === undefined ? '' : ` · ${all}% across the session`}`,
        })
      }
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
      const marker = p === undefined ? '' : p.ratio > AHEAD ? '▴' : p.ratio < BEHIND ? '▾' : ''
      const full = p?.fullIn === undefined ? '' : ` → full ${duration(p.fullIn)}`
      const base = byUsed(pct)
      parts.push({
        text: `${label} ${pct}%${marker}${kind === 'five_hour' && reset ? ` ↻ ${reset}` : ''}${full}`,
        // running out before the reset is worth a yellow even while the share is low
        level: p?.fullIn !== undefined && base === 'ok' ? 'warn' : base,
        group: 'quota',
        detail: [
          `${label} ${pct}% used`,
          reset === undefined ? undefined : `resets in ${reset}`,
          p === undefined ? undefined : `pace ${p.ratio.toFixed(1)}x an even burn`,
          p?.fullIn === undefined ? undefined : `full in ${duration(p.fullIn)}`,
        ].filter(part => part !== undefined).join(' · '),
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
