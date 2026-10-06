import type { EngineInterface, Register } from 'claude-code'

import { formatSegments, type Level, type LineInput } from './format'

let lastTurn: LineInput['lastTurn']
let contextPercent: number | undefined
let rateLimits: LineInput['rateLimits'] = []
let stopTick: (() => void) | undefined
let stopPoll: (() => void) | undefined

const POLL_MS = 5_000

// Hex: muted green, amber, vermilion red.
const COLOR: Record<Level, string | undefined> = {
  ok: '#5E8F55',
  warn: '#c9a400',
  bad: '#e2421f',
  none: undefined,
}

// Faint gray layer so the band reads apart from the context above it.
const PANEL = '#F4F4F0'

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
    // a minute ticker phased on this request: it restarts the cache TTL, so
    // the countdown changes exactly when a whole minute crosses
    if (e.agentId === undefined) {
      stopTick?.()
      stopTick = $.clock.every(60_000, () => redraw($))
    }
    const r = yield* next(e)
    if (r.usage && e.agentId === undefined) {
      lastTurn = {
        cachedAt: sentAt,
        input: r.usage.input_tokens,
        cacheRead: r.usage.cache_read_input_tokens,
        cacheWrite: r.usage.cache_creation_input_tokens,
      }
      redraw($)
    }
    return r
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
    return (
      <Box paddingX={1} backgroundColor={PANEL}>
        {segments.map((s, i) => (
          <Text key={String(i)}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color={COLOR[s.level]} dimColor={s.level === 'none'}>
              {s.text}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
