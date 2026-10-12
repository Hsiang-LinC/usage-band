import type { EngineInterface, Register, Timer } from 'claude-code'

import { formatSegments, type Level, type LineInput } from './format'

type CacheUsage = NonNullable<NonNullable<LineInput['cache']>['usage']>
// newest main-thread request whose response reported usage
let answered: { sentAt: number; usage: CacheUsage } | undefined
// main-thread requests in flight, by identity (two may share a millisecond);
// the icon grows only while this is non-empty
const pending = new Set<{ sentAt: number }>()
// when the newest keep-warm request was sent: like any request, it restarts
// the cache's TTL
let warmedAt: number | undefined
let warming = false
let lastWarm: number | undefined
let contextPercent: number | undefined
let rateLimits: LineInput['rateLimits'] = []
let tick: Timer | undefined
let poll: Timer | undefined
let frame = 0
let anim: Timer | undefined

const POLL_MS = 5_000
// a keep-warm press is ignored this long after the last one
const WARM_COOLDOWN_MS = 30_000
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

function press($: EngineInterface, kind: 'compact' | 'warm') {
  return kind === 'compact' ? compact($) : warm($)
}

// The same call /compact makes. It is refused while a request runs (the band
// offers it only when idle, but the press can land just after one starts);
// either way the person is told, and nothing is retried.
async function compact($: EngineInterface) {
  try {
    const r = await $.session.compact()
    if (r.skip !== undefined) return void $.ui.toast(`compact skipped: ${r.skip}`)
  } catch (error) {
    return void $.ui.toast(`compact failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  // the compacted transcript is a new prefix: what was cached no longer
  // matches, so the next request starts the countdown afresh
  answered = undefined
  warmedAt = undefined
  tick?.cancel()
  tick = undefined
  redraw($)
}

// A minimal request over the session's own prefix: it reads the cached
// prefix, which restarts the TTL, and answers one word. Not retried; a
// failure or a cut-off request is toasted and leaves the countdown alone.
async function warm($: EngineInterface) {
  warming = true
  redraw($)
  const sentAt = await $.clock.now()
  try {
    const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
    if (!r.isAnswered) return void $.ui.toast(`keep-warm failed: ${r.reason}`)
    warmedAt = sentAt
    phaseTicker($, await $.clock.now())
    const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = r.usage
    $.ui.toast(read >= written
      ? `cache kept warm (${read} tokens read)`
      : `cache had lapsed: ${written} tokens written again`)
  } catch (error) {
    $.ui.toast(`keep-warm failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    warming = false
    lastWarm = await $.clock.now()
    // the button comes back once the cooldown is over
    $.clock.after(WARM_COOLDOWN_MS, () => redraw($))
    redraw($)
  }
}

// The countdown runs from the newest request sent, answered or still in
// flight; the hit rate is the newest answered one's.
function cacheState(): LineInput['cache'] {
  let sentAt = answered?.sentAt
  for (const request of pending) {
    if (sentAt === undefined || request.sentAt > sentAt) sentAt = request.sentAt
  }
  if (warmedAt !== undefined && (sentAt === undefined || warmedAt > sentAt)) sentAt = warmedAt
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
      if (r.usage) {
        const usage = {
          input: r.usage.input_tokens,
          cacheRead: r.usage.cache_read_input_tokens,
          cacheWrite: r.usage.cache_creation_input_tokens,
        }
        if (answered === undefined || request.sentAt >= answered.sentAt) {
          answered = { sentAt: request.sentAt, usage }
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
    const now = await $.clock.now()
    const segments = formatSegments({
      contextPercent,
      rateLimits,
      cache: cacheState(),
      canCompact: pending.size === 0,
      canWarm: pending.size === 0 && !warming && (lastWarm === undefined || now - lastWarm >= WARM_COOLDOWN_MS),
      now,
    })
    if (segments.length === 0) return next(e)

    // other mods share the band (vault-jot adds its row), so draw on top of
    // what lies beneath rather than in its place
    const beneath = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const theme = await palette($)
    // label dim-free, values bold: "5h 20% ↻ 2h13m" bolds 20% and 2h13m
    const body = (s: (typeof segments)[number]) => (
      <Text color={theme.colors[s.level]}>
        <Text>{s.text.slice(0, s.text.indexOf(' ') + 1)}</Text>
        {s.text.slice(s.text.indexOf(' ') + 1).split(/(<?\d+(?:[dh]\d+)?[dhm%])/).filter(text => text !== '').map((text, j) => (
          <Text key={String(j)} bold={/^(<?\d+(?:[dh]\d+)?[dhm%])$/.test(text)}>{text}</Text>
        ))}
      </Text>
    )
    return (
      <Box flexDirection="column">
        <Box paddingX={1}>
          {/* the frames' glyphs differ in width where the font falls back (desktop), so a fixed cell keeps the text after still */}
          <Box width={2} flexShrink={0}>
            <Text color={theme.stars[Math.floor(frame / STARS.length)]}>{STARS[frame % STARS.length]}</Text>
          </Box>
          {/* A Button cannot sit inside an inline Text, so the segments are flex
              items. The desktop trims whitespace at each item's edges: the gaps
              between items come from `gap`, never from spaces in the separators. */}
          <Box gap={1} flexWrap="wrap">
            {segments.flatMap((s, i) => [
              ...(i > 0
                ? [<Text key={`sep-${i}`} color={theme.neutral}>{segments[i - 1].group === s.group ? '·' : '│'}</Text>]
                : []),
              <Box key={`seg-${i}`} gap={1}>
                {body(s)}
                {s.action === undefined ? null : s.action.kind === 'warm' ? (
                  // a fixed cell: the sign is a different width where the font falls back
                  <Box width={2} flexShrink={0}>
                    {s.action.isEnabled ? (
                      <Button key="warm" plain onPress={() => press($, 'warm')}>{s.action.label}</Button>
                    ) : (
                      <Text dimColor>{s.action.label}</Text>
                    )}
                  </Box>
                ) : s.action.isEnabled ? (
                  <Button key={s.action.kind} plain onPress={() => press($, s.action!.kind)}>{s.action.label}</Button>
                ) : null}
              </Box>,
            ])}
          </Box>
        </Box>
        {beneath}
      </Box>
    )
  })
}
