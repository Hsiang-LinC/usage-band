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
  expect(seg(50 * 60_000, 70).map(s => s.level)).toEqual(['ok', 'warn'])
  expect(seg(56 * 60_000, 80).map(s => s.level)).toEqual(['warn', 'bad'])
  expect(seg(61 * 60_000, 49).map(s => s.level)).toEqual(['bad', 'ok'])
})

test('ctx warns at 50%, and at 80% suggests compacting or handing off', () => {
  const ctx = (contextPercent: number) =>
    formatSegments({ contextPercent, rateLimits: [], now: 0 })[0]
  expect(ctx(49.9)).toEqual({ text: 'ctx 49%', level: 'ok', group: 'session' })
  expect(ctx(50)).toEqual({ text: 'ctx 50%', level: 'warn', group: 'session' })
  expect(ctx(80)).toEqual({
    text: 'ctx 80% → /compact or hand off',
    level: 'bad',
    group: 'session',
  })
})

test('5h shows time to reset; past or missing reset is omitted', () => {
  const at = (resetsAt?: string, now = 0) =>
    formatLine({
      rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt }],
      now,
    })
  const t = (ms: number) => new Date(ms).toISOString()
  // (the pace marker is covered below; here only the reset time matters)
  expect(at(t(2 * 3_600_000 + 13 * 60_000))).toContain('5h 10%▾ ↻ 2h13m')
  expect(at(t(45 * 60_000))).toContain('↻ 45m')
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

test('a burn faster than even marks the window and says when it runs out', () => {
  // 50% used after 1h of 5h: 2.5x an even burn, full in another hour
  expect(formatLine(five(50, HOUR))).toBe('cache -- · 5h 50%▴ ↻ 4h00m → full 1h00m')
  const [, five_h] = formatSegments(five(50, HOUR))
  expect(five_h.detail).toBe('5h 50% used · resets in 4h00m · pace 2.5x an even burn · full in 1h00m')
})

test('running out before the reset turns a low share yellow', () => {
  expect(formatSegments(five(30, HOUR))[1].level).toBe('warn')
  expect(formatSegments(five(10, 2 * HOUR))[1].level).toBe('ok')
})

test('a slower than even burn is marked and never projects exhaustion', () => {
  // 10% used after 2.5h of 5h: 0.2x
  expect(formatLine(five(10, 2.5 * HOUR))).toBe('cache -- · 5h 10%▾ ↻ 2h30m')
})

test('an even burn carries no marker', () => {
  expect(formatLine(five(50, 2.5 * HOUR))).toBe('cache -- · 5h 50% ↻ 2h30m')
})

test('pace waits until a tenth of the window has passed, and needs a reset time', () => {
  expect(formatLine(five(40, 0.4 * HOUR))).toBe('cache -- · 5h 40% ↻ 4h36m')
  expect(formatLine({ rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], now: 0 })).toBe('cache -- · 5h 40%')
})

test('the weekly window gets a pace too, with days in its reset', () => {
  const week = 7 * 24 * HOUR
  const line = formatSegments({
    rateLimits: [{ kind: 'seven_day', percentUsed: 90, resetsAt: at(week - 24 * HOUR) }],
    now: 0,
  })[1]
  // 90% after 1 of 7 days burns 6.3x; the remaining 10% lasts ~2.7h
  expect(line.text).toBe('7d 90%▴ → full 2h40m')
  expect(line.detail).toContain('resets in 6d00h')
})

test('a full window projects nothing', () => {
  expect(formatLine(five(100, HOUR))).toBe('cache -- · 5h 100%▴ ↻ 4h00m')
})

test('pressing hit shows the newest request and the session', () => {
  const [, hit] = formatSegments({
    rateLimits: [],
    cache: { sentAt: 0, usage: { input: 100, cacheRead: 900, cacheWrite: 0 }, total: { input: 200, cacheRead: 900, cacheWrite: 900 } },
    now: 60_000,
  })
  expect(hit).toMatchObject({ text: 'hit 90%', level: 'ok', group: 'session' })
  expect(hit.detail).toBe('hit 90% on the newest request (read 900 · written 0 · uncached 100 tokens) · 45% across the session')
})

test('only quota and hit are pressable', () => {
  const pressable = formatSegments({
    contextPercent: 40,
    rateLimits: [{ kind: 'five_hour', percentUsed: 20 }],
    cache: { sentAt: 0, usage: { input: 100, cacheRead: 900, cacheWrite: 0 } },
    now: 60_000,
  }).filter(s => s.detail !== undefined).map(s => s.text.split(' ')[0])
  expect(pressable).toEqual(['hit', '5h'])
})
