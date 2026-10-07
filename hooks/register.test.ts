import { expect, test, mock } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${surface}: ${theme} palette and only values are bold`, async ($, on) => {
      mock.clock(on)
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

for (const appearance of ['light', 'dark'] as const) {
  test(`auto uses macOS ${appearance} appearance and caches detection`, async ($, on) => {
    const clock = mock.clock(on)
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
