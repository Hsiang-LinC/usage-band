import { expect, test } from 'claude-code/testing'

import { formatLine, formatSegments } from './format'

test('formats ctx, cache, hit and quota used', () => {
  const line = formatLine({
    contextPercent: 42.9,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20.5 },
      { kind: 'seven_day', percentUsed: 70 },
    ],
    lastTurn: { endedAt: 0, input: 100, cacheRead: 900, cacheWrite: 0 },
    now: 60_000,
  })
  expect(line).toBe('ctx 42% · cache 59m hit 90% · 5h 20% · 7d 70%')
})

test('cache goes cold after the TTL and absent data is skipped', () => {
  expect(
    formatLine({
      rateLimits: [],
      lastTurn: { endedAt: 0, input: 0, cacheRead: 0, cacheWrite: 0 },
      now: 3_700_000,
    }),
  ).toBe('cache cold')
})

test('shows a placeholder before any turn has completed', () => {
  expect(formatLine({ rateLimits: [], now: 0 })).toBe('cache --')
})

test('levels follow usage and remaining cache time', () => {
  const seg = (now: number, five: number) =>
    formatSegments({
      rateLimits: [{ kind: 'five_hour', percentUsed: five }],
      lastTurn: { endedAt: 0, input: 0, cacheRead: 0, cacheWrite: 0 },
      now,
    })
  expect(seg(0, 10).map(s => s.level)).toEqual(['ok', 'ok'])
  expect(seg(50 * 60_000, 70).map(s => s.level)).toEqual(['warn', 'warn'])
  expect(seg(58 * 60_000, 90).map(s => s.level)).toEqual(['bad', 'bad'])
})
