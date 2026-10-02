import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'clawd',
  props: { title: 'HQ', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: { columns: 160, rows: 40 },
} as const

test('the HQ draws, its menus open and Clawd takes a pet on every surface', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd', surface, ...PANE })
    if (surface === 'terminal') {
      expect(await ui.find({ key: 'scene' })).toBeDefined()
      await ui.press({ key: 'Limits' })
      expect(await ui.find({ type: 'Text', text: /LIMITS/ })).toBeDefined()
      await ui.press({ key: 'Limits' })
      expect(await ui.find({ type: 'Text', text: /LIMITS/ })).toBeUndefined()
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
      await ui.press({ key: 'session' })
    }
    await ui.press({ key: surface === 'terminal' ? 'Pet' : '♥ Pet' })
    await ui.unmount()
  }
})

test('another Claude on the machine walks into the office and can be waved at', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files: Record<string, string> = {
    '/home/me/.claude/clawd-crew/other.json': JSON.stringify({
      id: 'other', name: 'webapp', x: 60, walkFrom: 60, walkAt: 0, mood: 'work', station: 'desk',
      tool: 'Edit', agents: 0, at: 1_000_000, wave: 0, mail: null,
    }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ deny: 'test' }) as never)
  on('session.id', () => ({ value: 'mine' }))
  on('session.cwd', () => ({ value: '/home/me/ws/my-app' }))
  on('fs.write', ($, e) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: Object.keys(files).map(p => ({ name: p.split('/').pop()!, kind: 'file', size: 1, mtimeMs: clock.now(), isSymlink: false })) }) as never)
  on('fs.read', ($, e) => ({ value: files[e.path]! }))
  await $.session.start({ source: 'startup', cwd: '/home/me/ws/my-app', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1600)
  const mine = JSON.parse(files['/home/me/.claude/clawd-crew/mine.json']!)
  expect(mine.name).toBe('my-app')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /webapp/ })).toBeDefined()
    await ui.press({ key: surface === 'terminal' ? 'Wave' : '👋 Wave' })
    await ui.unmount()
  }
  await clock.advance(1100)
  expect(JSON.parse(files['/home/me/.claude/clawd-crew/mine.json']!).wave).toBeGreaterThan(0)
})

test('a roomy pane gets the full office, scaled to fit, proportions kept', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const ui = await $.ui.mount({ plugin: 'clawd', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 120, scroll: { offset: 0, bodyRows: 41 } } })
  const scene = (await ui.find({ key: 'scene' })) as { props: { columns: number; rows: number } }
  // capped by the default 96 column width: half size, 96 × 27
  expect(scene.props.columns).toBe(96)
  expect(scene.props.rows).toBe(27)
  await ui.unmount()
})

test('a small pane gets the office drawn in characters', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const ui = await $.ui.mount({ plugin: 'clawd', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 } } })
  const scene = (await ui.find({ key: 'scene' })) as { props: { columns: number; rows: number } }
  // 14 rows left: the full room would be shrunk to a third, so the 64 column one in characters draws
  expect(scene.props.columns).toBe(64)
  expect(scene.props.rows).toBe(14)
  await ui.unmount()
})

test('a pane a row short drops the top of the wall', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const ui = await $.ui.mount({ plugin: 'clawd', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 80, scroll: { offset: 0, bodyRows: 18 } } })
  const scene = (await ui.find({ key: 'scene' })) as { props: { columns: number; rows: number } }
  expect(scene.props.columns).toBe(64)
  expect(scene.props.rows).toBe(13)
  await ui.unmount()
})
