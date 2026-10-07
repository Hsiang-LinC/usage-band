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
  expect(at(t(2 * 3_600_000 + 13 * 60_000))).toBe('cache -- · 5h 10% ↻ 2h13m')
  expect(at(t(45 * 60_000))).toBe('cache -- · 5h 10% ↻ 45m')
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
  const at = (now: number) => formatSegments({
    rateLimits: [],
    cache: { sentAt: 0, usage: { input: 100, cacheRead: 900, cacheWrite: 0 } },
    now,
  })[0].text
  expect(at(3_599_999)).toBe('cache <1m · hit 90%')
  expect(at(3_600_000)).toBe('cache cold')
  expect(at(3_600_001)).toBe('cache cold')
})
