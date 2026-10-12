import { expect, test } from 'claude-code/testing'

import { formatLine, formatSegments } from './format'

test('formats ctx, cache, hit and quota used', () => {
  const line = formatLine({
    contextPercent: 42.9,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20.5 },
      { kind: 'seven_day', percentUsed: 70 },
    ],
    cache: { sentAt: 0, usage: { input: 100, cacheRead: 900, cacheWrite: 0 } },
    now: 60_000,
  })
  expect(line).toBe('ctx 42% · cache 59m · hit 90% · 5h 20% · 7d 70%')
})

test('cache goes cold after the TTL and absent data is skipped', () => {
  expect(
    formatLine({
      rateLimits: [],
      cache: { sentAt: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } },
      now: 3_700_000,
    }),
  ).toBe('cache cold')
})

test('shows a placeholder before any request has been sent', () => {
  expect(formatLine({ rateLimits: [], now: 0 })).toBe('cache --')
})

test('counts down without a hit rate until the first request answers', () => {
  expect(formatLine({ rateLimits: [], cache: { sentAt: 0 }, now: 0 })).toBe('cache 60m')
})

test('levels follow usage and remaining cache time', () => {
  const seg = (now: number, five: number) =>
    formatSegments({
      rateLimits: [{ kind: 'five_hour', percentUsed: five }],
      cache: { sentAt: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } },
      now,
    })
  expect(seg(0, 10).map(s => s.level)).toEqual(['ok', 'ok'])
  expect(seg(30 * 60_000, 70).map(s => s.level)).toEqual(['ok', 'warn'])
  // yellow once 20 minutes or fewer are left
  expect(seg(40 * 60_000, 10).map(s => s.level)).toEqual(['warn', 'ok'])
  expect(seg(56 * 60_000, 80).map(s => s.level)).toEqual(['warn', 'bad'])
  expect(seg(61 * 60_000, 49).map(s => s.level)).toEqual(['bad', 'ok'])
})

test('ctx turns yellow at 50% and red at 80%', () => {
  const ctx = (contextPercent: number) =>
    formatSegments({ contextPercent, rateLimits: [], now: 0 })[0]
  expect(ctx(49.9)).toEqual({ text: 'ctx 49%', level: 'ok', group: 'session' })
  expect(ctx(50)).toEqual({ text: 'ctx 50%', level: 'warn', group: 'session' })
  expect(ctx(80)).toEqual({ text: 'ctx 80%', level: 'bad', group: 'session' })
})

test('5h shows time to reset; past or missing reset is omitted', () => {
  const at = (resetsAt?: string, now = 0) =>
    formatLine({
      rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt }],
      now,
    })
  const t = (ms: number) => new Date(ms).toISOString()
  // (the sign is covered below; here only the reset time matters)
  expect(at(t(2 * 3_600_000 + 13 * 60_000))).toContain('5h 10% ▾ 2h13m')
  expect(at(t(45 * 60_000))).toContain(' 45m')
  expect(at(t(1_000), 5_000)).toBe('cache -- · 5h 10%')
  expect(at(undefined)).toBe('cache -- · 5h 10%')
})

test('a cold cache drops the hit rate, since nothing is cached to hit', () => {
  expect(
    formatLine({
      rateLimits: [],
      cache: { sentAt: 0, usage: { input: 100, cacheRead: 900, cacheWrite: 0 } },
      now: 3_700_000,
    }),
  ).toBe('cache cold')
})

test('ctx and cache are the session group, 5h and 7d the quota group', () => {
  const groups = formatSegments({
    contextPercent: 1,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 1 },
      { kind: 'seven_day', percentUsed: 1 },
    ],
    now: 0,
  }).map(s => s.group)
  expect(groups).toEqual(['session', 'session', 'quota', 'quota'])
})


test('hit disappears exactly when the cache expires, without a trailing separator', () => {
  const at = (now: number) => formatLine({
    rateLimits: [],
    cache: { sentAt: 0, usage: { input: 100, cacheRead: 900, cacheWrite: 0 } },
    now,
  })
  expect(at(3_599_999)).toBe('cache <1m · hit 90%')
  expect(at(3_600_000)).toBe('cache cold')
  expect(at(3_600_001)).toBe('cache cold')
})

const HOUR = 3_600_000
const at = (ms: number) => new Date(ms).toISOString()

// 5h window, `elapsed` ms in, `pct` used
const five = (pct: number, elapsed: number) => ({
  rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: at(5 * HOUR - elapsed) }],
  now: 0,
})

test('the sign shows how fast the window is being used: slow, even or fast', () => {
  // an even burn is 50% used halfway through the 5h window
  const sign = (pct: number, elapsed: number) => formatLine(five(pct, elapsed)).replace(/^cache -- · 5h \d+% (\S).*$/, '$1')
  expect(sign(10, 2.5 * HOUR)).toBe('▾') // 0.2x
  expect(sign(30, 2.5 * HOUR)).toBe('▾') // 0.6x
  expect(sign(40, 2.5 * HOUR)).toBe('▪') // 0.8x
  expect(sign(50, 2.5 * HOUR)).toBe('▪') // 1x
  expect(sign(62, 2.5 * HOUR)).toBe('▪') // 1.24x
  expect(sign(70, 2.5 * HOUR)).toBe('▴') // 1.4x
  expect(sign(50, HOUR)).toBe('▴') // 2.5x
})

test('pace waits until a tenth of the window has passed, and needs a reset time', () => {
  // before that the 5h window keeps the plain reset sign
  expect(formatLine(five(40, 0.4 * HOUR))).toBe('cache -- · 5h 40% ◦ 4h36m')
  expect(formatLine({ rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], now: 0 })).toBe('cache -- · 5h 40%')
})

test('the weekly window gets the sign, but no reset time', () => {
  const week = 7 * 24 * HOUR
  const text = (pct: number, elapsed: number) => formatSegments({
    rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: at(week - elapsed) }],
    now: 0,
  })[1].text
  expect(text(90, 24 * HOUR)).toBe('7d 90% ▴')
  expect(text(50, 3.5 * 24 * HOUR)).toBe('7d 50% ▪')
  // too early in the week for a pace: nothing but the share
  expect(text(5, 6 * HOUR)).toBe('7d 5%')
})

test('a full window projects nothing', () => {
  expect(formatLine(five(100, HOUR))).toBe('cache -- · 5h 100% ▴ 4h00m')
})

test('ctx is pressable (compact) once it is yellow, only while idle', () => {
  const ctx = (contextPercent: number, canCompact?: boolean) =>
    formatSegments({ contextPercent, rateLimits: [], canCompact, now: 0 })[0]
  expect(ctx(49, true).action).toBeUndefined()
  expect(ctx(50, true)).toMatchObject({ text: 'ctx 50%', level: 'warn', action: { kind: 'compact', isEnabled: true } })
  expect(ctx(85, true)).toMatchObject({ text: 'ctx 85%', level: 'bad', action: { kind: 'compact', isEnabled: true } })
  // a request in flight: /compact would be refused
  expect(ctx(50, false).action).toBeUndefined()
})

test('the keep-warm sign is always there; it is live only under 30 minutes, for an idle session', () => {
  const cache = (minutesLeft: number, canWarm?: boolean) =>
    formatSegments({ rateLimits: [], cache: { sentAt: 0 }, canWarm, now: (60 - minutesLeft) * 60_000 })[0]
  const live = { kind: 'warm', label: '♨', isEnabled: true }
  expect(cache(59, true)).toMatchObject({ text: 'cache 59m', level: 'ok', action: { kind: 'warm', isEnabled: false } })
  expect(cache(30, true).action).toMatchObject({ isEnabled: false })
  expect(cache(29, true).action).toMatchObject(live)
  // the colour of the cache segment is what turns as the end nears: one threshold
  expect(cache(21, true)).toMatchObject({ text: 'cache 21m', level: 'ok' })
  expect(cache(20, true)).toMatchObject({ text: 'cache 20m', level: 'warn' })
  expect(cache(5, true)).toMatchObject({ text: 'cache 5m', level: 'warn', action: live })
  expect(cache(0.5, true)).toMatchObject({ text: 'cache <1m', level: 'warn', action: live })
  // a request in flight or one just sent: the sign stays, inert
  expect(cache(10, false).action).toMatchObject({ kind: 'warm', isEnabled: false })
  expect(cache(10).action).toMatchObject({ kind: 'warm', isEnabled: false })
  // a cold cache is not warmed (the request would write the whole prefix again), nor is one not yet started
  const cold = formatSegments({ rateLimits: [], cache: { sentAt: 0 }, canWarm: true, now: 61 * 60_000 })[0]
  expect(cold).toMatchObject({ text: 'cache cold', action: { kind: 'warm', isEnabled: false } })
  expect(formatSegments({ rateLimits: [], canWarm: true, now: 0 })[0]).toMatchObject({ text: 'cache --', action: { kind: 'warm', isEnabled: false } })
})
