import type { EngineInterface, Register } from 'claude-code'

import { formatSegments, type Level, type LineInput } from './format'

let lastTurn: LineInput['lastTurn']
let contextPercent: number | undefined
let rateLimits: LineInput['rateLimits'] = []

const COLOR: Record<Level, string | undefined> = {
  ok: 'green',
  warn: 'yellow',
  bad: 'red',
  none: undefined,
}

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const u = await $.session.usage()
    contextPercent = u.context.percent
    rateLimits = u.rateLimits
    redraw($)
    // keeps the cache countdown moving between events
    $.clock.every(15_000, () => redraw($))
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
    const r = yield* next(e)
    if (r.usage && e.agentId === undefined) {
      lastTurn = {
        endedAt: await $.clock.now(),
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
      <Box>
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
