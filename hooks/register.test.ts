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
