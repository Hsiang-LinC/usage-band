import type { EngineInterface, Register } from 'claude-code'

import { formatSegments, type Level, type LineInput } from './format'

let lastTurn: LineInput['lastTurn']
let contextPercent: number | undefined
let rateLimits: LineInput['rateLimits'] = []
let stopTick: (() => void) | undefined
let stopPoll: (() => void) | undefined
// main-thread requests in flight; the icon grows only while this is > 0
let busy = 0
let frame = 0
let stopAnim: (() => void) | undefined

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
    stopPoll?.()
    stopPoll = $.clock.every(POLL_MS, () => refreshUsage($))
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
    const sentAt = await $.clock.now()
    const isMain = e.agentId === undefined
    // a minute ticker phased on this request: it restarts the cache TTL, so
    // the countdown changes exactly when a whole minute crosses
    if (isMain) {
      stopTick?.()
      stopTick = $.clock.every(60_000, () => redraw($))
    }
    if (isMain && ++busy === 1) {
      frame = 0
      stopAnim = $.clock.every(ANIM_MS, () => {
        frame = (frame + 1) % FRAME_COUNT
        redraw($)
      })
    }
    try {
      const r = yield* next(e)
      if (r.usage && isMain) {
        lastTurn = {
          cachedAt: sentAt,
          input: r.usage.input_tokens,
          cacheRead: r.usage.cache_read_input_tokens,
          cacheWrite: r.usage.cache_creation_input_tokens,
        }
      }
      return r
    } finally {
      if (isMain && --busy === 0) {
        stopAnim?.()
        frame = 0
      }
      redraw($)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const segments = formatSegments({
      contextPercent,
      rateLimits,
      lastTurn,
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
