import type { EngineInterface, Register, Timer } from 'claude-code'

import { formatSegments, type Level, type LineInput } from './format'

type CacheUsage = NonNullable<NonNullable<LineInput['cache']>['usage']>
// newest main-thread request whose response reported usage
let answered: { sentAt: number; usage: CacheUsage } | undefined
// main-thread requests in flight, by identity (two may share a millisecond);
// the icon grows only while this is non-empty
const pending = new Set<{ sentAt: number }>()
let contextPercent: number | undefined
let rateLimits: LineInput['rateLimits'] = []
let tick: Timer | undefined
let poll: Timer | undefined
let frame = 0
let anim: Timer | undefined

const POLL_MS = 5_000
const ANIM_MS = 200
const STARS = ['✶', '✴', '✷', '✦', '✧', '✦']
// One full shape cycle (1.2s) per colour; no opacity blinking.
const FRAME_COUNT = STARS.length * 3
const PALETTES = {
  light: {
    neutral: '#61675F',
    colors: { ok: '#286044', warn: '#755812', bad: '#983E32', none: '#61675F' },
    stars: ['#755812', '#416579', '#983E32'],
  },
  dark: {
    neutral: '#A2A99F',
    colors: { ok: '#82B58B', warn: '#C5A35B', bad: '#DC9180', none: '#A2A99F' },
    stars: ['#C5A35B', '#8BAABD', '#DC9180'],
  },
} satisfies Record<'light' | 'dark', {
  neutral: string; colors: Record<Level, string>; stars: string[]
}>

// The mod API exposes the selected theme, not auto's resolved appearance.
// On macOS, auto/custom themes follow system appearance, cached for 5s.
let systemAppearance: Promise<'light' | 'dark'> | undefined
let appearanceExpires = 0
async function palette($: EngineInterface) {
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  if (typeof theme !== 'string') throw new Error('usage-band: missing theme config')
  if (/^light(?:-|$)/.test(theme)) return PALETTES.light
  if (/^dark(?:-|$)/.test(theme)) return PALETTES.dark
  if (theme !== 'auto' && !theme.startsWith('custom:')) {
    throw new Error('usage-band: unsupported theme selection')
  }
  const now = await $.clock.now()
  if (!systemAppearance || now >= appearanceExpires) {
    appearanceExpires = now + POLL_MS
    systemAppearance = $.process.run(
      ['/usr/bin/defaults', 'read', '-g', 'AppleInterfaceStyle'],
      { timeoutMs: 1000 },
    ).then(result => {
      if (result.exitCode === 0 && result.stdout.trim() === 'Dark') return 'dark'
      if (result.exitCode === 1 && /AppleInterfaceStyle.*does not exist/.test(result.stderr)) return 'light'
      throw new Error('usage-band: cannot read macOS system appearance')
    })
  }
  return PALETTES[await systemAppearance]
}

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

// The countdown runs from the newest request sent, answered or still in
// flight; the hit rate is the newest answered one's.
function cacheState(): LineInput['cache'] {
  let sentAt = answered?.sentAt
  for (const request of pending) {
    if (sentAt === undefined || request.sentAt > sentAt) sentAt = request.sentAt
  }
  return sentAt === undefined ? undefined : { sentAt, usage: answered?.usage }
}

// A minute ticker phased on the countdown's start, so the band redraws
// exactly when a whole minute crosses.
function phaseTicker($: EngineInterface, now: number) {
  tick?.cancel()
  tick = undefined
  const cache = cacheState()
  if (cache === undefined) return
  tick = $.clock.after(60_000 - ((now - cache.sentAt) % 60_000), () => {
    redraw($)
    tick = $.clock.every(60_000, () => redraw($))
  })
}

async function refreshUsage($: EngineInterface) {
  const u = await $.session.usage()
  contextPercent = u.context.percent
  rateLimits = u.rateLimits
  redraw($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refreshUsage($)
    // keeps 5h/7d fresh in idle sessions, where no measure event fires
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => refreshUsage($))
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    contextPercent = e.context.percent
    rateLimits = e.rateLimits
    redraw($)
    return next(e)
  })

  // per request, not per turn: a turn's usage sums every request of its tool
  // loop, and only the latest request says how warm the cache is now
  on('turn.step', async function* ($, e, next) {
    // sub-agents send other prefixes; they neither read nor refresh this cache
    if (e.agentId !== undefined) return yield* next(e)
    const request = { sentAt: await $.clock.now() }
    // the TTL restarts as the request is sent, so count down from now at once,
    // keeping the last answered hit rate until this response reports its own
    pending.add(request)
    phaseTicker($, request.sentAt)
    if (pending.size === 1) {
      frame = 0
      anim = $.clock.every(ANIM_MS, () => {
        frame = (frame + 1) % FRAME_COUNT
        redraw($)
      })
    }
    redraw($)
    try {
      const r = yield* next(e)
      if (r.usage && (answered === undefined || request.sentAt >= answered.sentAt)) {
        answered = {
          sentAt: request.sentAt,
          usage: {
            input: r.usage.input_tokens,
            cacheRead: r.usage.cache_read_input_tokens,
            cacheWrite: r.usage.cache_creation_input_tokens,
          },
        }
      }
      return r
    } finally {
      // a request that failed or was cut off without usage confirms nothing
      // about the cache: dropping it rolls the countdown back
      pending.delete(request)
      if (pending.size === 0) {
        anim?.cancel()
        anim = undefined
        frame = 0
      }
      phaseTicker($, await $.clock.now())
      redraw($)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const segments = formatSegments({
      contextPercent,
      rateLimits,
      cache: cacheState(),
      now: await $.clock.now(),
    })
    if (segments.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const theme = await palette($)
    return (
      <Box paddingX={1}>
        <Text color={theme.stars[Math.floor(frame / STARS.length)]}>{STARS[frame % STARS.length]} </Text>
        {segments.map((s, i) => (
          <Text key={String(i)}>
            {i > 0 ? (
              <Text color={theme.neutral}>{segments[i - 1].group === s.group ? ' · ' : ' │ '}</Text>
            ) : null}
            <Text color={theme.colors[s.level]}>
              <Text>{s.text.slice(0, s.text.indexOf(' ') + 1)}</Text>
              {s.text.slice(s.text.indexOf(' ') + 1).split(/(<?\d+(?:h\d+)?[hm%])/).map((text, j) => (
                <Text key={String(j)} bold={/^(<?\d+(?:h\d+)?[hm%])$/.test(text)}>{text}</Text>
              ))}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
