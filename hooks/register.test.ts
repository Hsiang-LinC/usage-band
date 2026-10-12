import { expect, test, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// What lies beneath this mod's hook: the engine's band, or another mod's row.
function engineBand(on: On, text?: string) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return text === undefined ? Box({ key: 'engine' }) : Text({ key: 'engine', children: [text] })
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${surface}: ${theme} palette and only values are bold`, async ($, on) => {
      mock.clock(on)
      engineBand(on)
      on('session.measure', () => ({ changed: [] }))
      on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: theme, provider: { kind: 'engine' }, isLocked: false }] }))
      await $.session.measure({ context: { percent: 32 }, rateLimits: [{ kind: 'five_hour', percentUsed: 86 }] })
      const ui = await $.ui.mount({ plugin: 'usage', surface, component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} } })
      expect((await ui.drawn()).props.backgroundColor).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /^32%$/ }))?.props).toMatchObject({ bold: true })
      expect((await ui.find({ type: 'Text', text: /^ctx $/ }))?.props.bold).not.toBe(true)
      expect((await ui.find({ type: 'Text', text: /^86%$/ }))?.props).toMatchObject({ bold: true })
      // the icon's frames differ in glyph width, so a fixed cell keeps the text after it still
      const icon = (await ui.findAll({ type: 'Box' })).filter(box => box.props.width !== undefined)
      expect(icon.map(box => box.props)).toMatchObject([{ width: 2, flexShrink: 0 }])
      expect(icon[0].children).toMatchObject([{ type: 'Text', children: ['✶'] }])
      await ui.unmount()
    })
  }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: segments are flex items spaced by gap, not by spaces`, async ($, on) => {
    mock.clock(on)
    engineBand(on)
    on('session.measure', () => ({ changed: [] }))
    on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
    await $.session.measure({ context: { percent: 32 }, rateLimits: [{ kind: 'five_hour', percentUsed: 86 }] })
    const ui = await $.ui.mount({ plugin: 'usage', surface, component: 'AbovePrompt', requestId: 'run-band', props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} } })
    // the desktop draws Box as a flex row and trims the whitespace at each
    // flex item's edges, so the spacing between items is `gap`, and no item
    // starts or ends with a space
    const [row] = (await ui.drawn()).children as [{ type: string; children: unknown[] }]
    expect(row.type).toBe('Box')
    expect(row.children).toMatchObject([{ type: 'Box', props: { width: 2 } }, { type: 'Box', props: { gap: 1 } }])
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    expect(texts.filter(text => text === '·' || text === '│')).toEqual(['·', '│'])
    expect(texts.filter(text => /^ | $/.test(text) && text.length > 1 && !/^(ctx|cache|5h) $/.test(text))).toEqual([])
    await ui.unmount()
  })
}

for (const appearance of ['light', 'dark'] as const) {
  test(`auto uses macOS ${appearance} appearance and caches detection`, async ($, on) => {
    const clock = mock.clock(on)
    engineBand(on)
    on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'auto', provider: { kind: 'engine' }, isLocked: false }] }))
    let reads = 0
    on('process.run', () => {
      reads++
      return { value: appearance === 'dark'
        ? { exitCode: 0, stdout: 'Dark\n', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist' } }
    })
    const target = { plugin: 'usage', surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'auto-band', props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} } }
    const ui = await $.ui.mount(target)
    expect((await ui.drawn()).props.backgroundColor).toBeUndefined()
    expect((await ui.findAll({ type: 'Text', text: /^cache --$/ })).some(element => element.props.color === (appearance === 'light' ? '#61675F' : '#A2A99F'))).toBe(true)
    await ui.unmount()
    const again = await $.ui.mount(target)
    expect(reads).toBe(1)
    await again.unmount()
    await clock.advance(5000)
    const refreshed = await $.ui.mount(target)
    expect(reads).toBe(2)
    await refreshed.unmount()
  })
}

test('cache figures follow every main-thread request, even after the cache went cold', async ($, on) => {
  const clock = mock.clock(on)
  engineBand(on)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
  let cacheRead = 0
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 100, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 900 - cacheRead },
    }
  })
  const step = async (index: number) => {
    const stream = $.turn.step({ turnId: 't', index, model: 'm', messageCount: 1 })
    for await (const _ of stream) { /* drain */ }
  }
  const target = { plugin: 'usage', surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'cache-band', props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} } }
  const shows = async (text: RegExp) => {
    const ui = await $.ui.mount(target)
    const found = (await ui.find({ type: 'Text', text })) !== undefined
    await ui.unmount()
    return found
  }

  await step(0)
  expect(await shows(/^0%$/)).toBe(true)

  await clock.advance(61 * 60_000)
  expect(await shows(/^cold$/)).toBe(true)

  cacheRead = 900
  await step(1)
  expect(await shows(/^cold$/)).toBe(false)
  expect(await shows(/^90%$/)).toBe(true)
})

// Answers each main-thread request once `answer` is called with its usage.
function stepper($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], clock: ReturnType<typeof mock.clock>) {
  const answers: ((usage: { cacheRead: number } | null) => void)[] = []
  let reached = 0
  on('turn.step', async function* (_$, e) {
    reached++
    const usage = await new Promise<{ cacheRead: number } | null>(resolve => answers.push(resolve))
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: usage ? 'end_turn' as const : null,
      usage: usage && { model: e.model, input_tokens: 100, output_tokens: 1, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: 900 - usage.cacheRead },
    }
  })
  let index = 0
  return {
    send: async () => {
      const stream = $.turn.step({ turnId: 't', index: index++, model: 'm', messageCount: 1 })
      const drained = (async () => { for await (const _ of stream) { /* drain */ } })()
      // let the request reach the answering hook, through the plugin's own
      for (let settles = 0; reached < index; settles++) {
        if (settles === 20) throw new Error('turn.step never reached the answering hook')
        await clock.advance(0)
      }
      // wrapped: an async function returning the promise would wait for it
      return { answered: drained }
    },
    answer: (usage: { cacheRead: number } | null) => answers.shift()!(usage),
  }
}

const bandTarget = { plugin: 'usage', surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'send-band', props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} } }

test('the countdown restarts when a request is sent, keeping the last hit until it answers', async ($, on) => {
  const clock = mock.clock(on)
  engineBand(on)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
  const steps = stepper($, on, clock)
  const shows = async (text: RegExp) => {
    const ui = await $.ui.mount(bandTarget)
    const found = (await ui.find({ type: 'Text', text })) !== undefined
    await ui.unmount()
    return found
  }

  let done = await steps.send()
  steps.answer({ cacheRead: 0 })
  await done.answered
  await clock.advance(30 * 60_000)
  expect(await shows(/^30m$/)).toBe(true)

  done = await steps.send()
  expect(await shows(/^60m$/)).toBe(true)
  expect(await shows(/^0%$/)).toBe(true)

  steps.answer({ cacheRead: 900 })
  await done.answered
  expect(await shows(/^60m$/)).toBe(true)
  expect(await shows(/^90%$/)).toBe(true)
})

test('a request that answers without usage rolls the countdown back', async ($, on) => {
  const clock = mock.clock(on)
  engineBand(on)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
  const steps = stepper($, on, clock)
  const shows = async (text: RegExp) => {
    const ui = await $.ui.mount(bandTarget)
    const found = (await ui.find({ type: 'Text', text })) !== undefined
    await ui.unmount()
    return found
  }

  let done = await steps.send()
  steps.answer({ cacheRead: 900 })
  await done.answered
  await clock.advance(30 * 60_000)

  done = await steps.send()
  expect(await shows(/^60m$/)).toBe(true)
  steps.answer(null)
  await done.answered
  expect(await shows(/^30m$/)).toBe(true)
  expect(await shows(/^90%$/)).toBe(true)

  await clock.advance(30 * 60_000)
  expect(await shows(/^cold$/)).toBe(true)
  // idle, so the icon rests on its first frame and does not animate
  expect(await shows(/^✶$/)).toBe(true)
  await clock.advance(1_000)
  expect(await shows(/^✶$/)).toBe(true)
})

test('the icon animates while a request runs and rests once it ends, though the cache is warm', async ($, on) => {
  const clock = mock.clock(on)
  engineBand(on)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
  const steps = stepper($, on, clock)
  const shows = async (text: RegExp) => {
    const ui = await $.ui.mount(bandTarget)
    const found = (await ui.find({ type: 'Text', text })) !== undefined
    await ui.unmount()
    return found
  }

  const done = await steps.send()
  await clock.advance(200)
  expect(await shows(/^✴$/)).toBe(true)

  steps.answer({ cacheRead: 900 })
  await done.answered
  // idle frames would redraw the band 5 times a second for the cache's hour
  await clock.advance(200)
  expect(await shows(/^59m$/)).toBe(true)
  expect(await shows(/^✶$/)).toBe(true)
})

// Other mods share the band (vault-jot adds its row), so the usage row goes
// on top of what lies beneath, never in its place.
test('keeps the drawing beneath under the usage row', async ($, on) => {
  mock.clock(on)
  engineBand(on, 'another mod')
  on('session.measure', () => ({ changed: [] }))
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
  await $.session.measure({ context: { percent: 32 }, rateLimits: [] })
  const ui = await $.ui.mount({ plugin: 'usage', surface: 'desktop', component: 'AbovePrompt', requestId: 'shared-band', props: { hasSurvey: false, isWorking: false, maxRows: 2, bodyColumns: 120, scroll: { offset: 0, bodyRows: 2 }, view: {} } })
  const root = await ui.drawn()
  expect(root.props).toMatchObject({ flexDirection: 'column' })
  expect(root.children).toMatchObject([{ type: 'Box' }, { type: 'Text', children: ['another mod'] }])
  await ui.unmount()
})

const compactBand = async (
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  compacting: () => unknown,
) => {
  mock.clock(on)
  engineBand(on)
  const toasts: string[] = []
  let compactions = 0
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.compact', () => { compactions++; return compacting() as never })
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
  await $.session.measure({ context: { percent: 45 }, rateLimits: [] })
  const ui = await $.ui.mount({ plugin: 'usage', surface: 'terminal', component: 'AbovePrompt', requestId: 'compact-band', props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} } })
  return { ui, toasts, compactions: () => compactions }
}

test('pressing compact runs /compact once and says nothing when it succeeds', async ($, on) => {
  on('session.measure', () => ({ changed: [] }))
  const { ui, toasts, compactions } = await compactBand($, on, () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  expect(await ui.find({ type: 'Button', text: /compact/ })).toBeDefined()
  // a Button is drawn in the surface's own style, so the segment's colour must
  // stay on the Text beside it
  expect((await ui.findAll({ type: 'Text' })).some(text => text.props.color === '#82B58B' && /^ctx/.test(text.text))).toBe(true)
  await ui.press({ plugin: 'usage', key: 'compact' })
  expect(compactions()).toBe(1)
  expect(toasts).toEqual([])
  await ui.unmount()
})

test('a vetoed or refused compact tells the person why', async ($, on) => {
  on('session.measure', () => ({ changed: [] }))
  const { ui, toasts } = await compactBand($, on, () => ({ skip: 'blocked by a hook' }))
  await ui.press({ plugin: 'usage', key: 'compact' })
  expect(toasts).toEqual(['compact skipped: blocked by a hook'])
  await ui.unmount()
})

test('the compact button is gone while a request is in flight', async ($, on) => {
  on('session.measure', () => ({ changed: [] }))
  let release: () => void = () => {}
  on('turn.step', async function* (_$, e) {
    await new Promise<void>(resolve => { release = resolve })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null }
  })
  const { ui } = await compactBand($, on, () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  const drained = (async () => { for await (const _ of stream) { /* drain */ } })()
  for (let settles = 0; settles < 20; settles++) await Promise.resolve()
  expect(await ui.find({ type: 'Button', text: /compact/ })).toBeUndefined()
  release()
  await drained
  expect(await ui.find({ type: 'Button', text: /compact/ })).toBeDefined()
  await ui.unmount()
})

// A session whose one request was sent at 0, `minutes` ago.
const warmBand = async (
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  fork: () => unknown,
  minutesAgo: number,
) => {
  const clock = mock.clock(on)
  engineBand(on)
  const toasts: string[] = []
  let forks = 0
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('model.fork', () => { forks++; return { value: fork() } as never })
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }] }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    }
  })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })) { /* drain */ }
  await clock.advance(minutesAgo * 60_000)
  const ui = await $.ui.mount({ plugin: 'usage', surface: 'terminal', component: 'AbovePrompt', requestId: 'warm-band', props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} } })
  return { ui, toasts, forks: () => forks, clock }
}
const answered = (read: number, written: number) => ({
  isAnswered: true, text: 'ok',
  usage: { model: 'm', input_tokens: 5, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: written },
})

test('pressing keep-warm restarts the countdown and reports what the cache served', async ($, on) => {
  const { ui, toasts, forks } = await warmBand($, on, () => answered(45_000, 0), 52)
  expect(await ui.find({ type: 'Text', text: /^8m$/ })).toBeDefined()
  await ui.press({ plugin: 'usage', key: 'warm' })
  expect(forks()).toBe(1)
  expect(toasts).toEqual(['cache kept warm (45000 tokens read)'])
  expect(await ui.find({ type: 'Text', text: /^(59|60)m$/ })).toBeDefined()
  await ui.unmount()
})

test('a lapsed cache is said to have been written again', async ($, on) => {
  const { ui, toasts } = await warmBand($, on, () => answered(0, 45_000), 52)
  await ui.press({ plugin: 'usage', key: 'warm' })
  expect(toasts).toEqual(['cache had lapsed: 45000 tokens written again'])
  await ui.unmount()
})

test('a failed keep-warm is toasted and leaves the countdown alone', async ($, on) => {
  const { ui, toasts } = await warmBand($, on, () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }), 52)
  await ui.press({ plugin: 'usage', key: 'warm' })
  expect(toasts).toEqual(['keep-warm failed: api-error'])
  expect(await ui.find({ type: 'Text', text: /^8m$/ })).toBeDefined()
  await ui.unmount()
})

test('the keep-warm button waits out a cooldown after a press', async ($, on) => {
  const { ui, forks, clock } = await warmBand($, on, () => answered(45_000, 0), 52)
  await ui.press({ plugin: 'usage', key: 'warm' })
  expect(await ui.find({ type: 'Button', text: /warm/ })).toBeUndefined()
  await clock.advance(31_000)
  expect(await ui.find({ type: 'Button', text: /warm/ })).toBeDefined()
  await ui.press({ plugin: 'usage', key: 'warm' })
  expect(forks()).toBe(2)
  await ui.unmount()
})

test('the keep-warm button is there from the first minute, not only near the end', async ($, on) => {
  const { ui } = await warmBand($, on, () => answered(45_000, 0), 1)
  expect(await ui.find({ type: 'Button', text: /warm/ })).toBeDefined()
  await ui.unmount()
})
