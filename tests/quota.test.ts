import { expect, test } from 'claude-code/testing'
import type { EngineInterface, Register } from 'claude-code'

type On = Parameters<Register>[0]

const measure = (percentUsed: number, resetsAt = '2026-11-08T12:00:00Z') => ({
  context: { window: 200_000 },
  rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }],
  changed: ['rateLimits'],
})

const COMPACTED = {
  messages: [{ role: 'user', text: 'summary', toolUses: [] }],
}

// The engine's timers stand in as waits that end at once.
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// Toasts go nowhere in a test.

test('compacts once per 5-hour window, from 98%', async ($, on) => {
  let compactions = 0
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    compactions += 1
    return COMPACTED as never
  })

  await $.session.measure(measure(97) as never)
  await settle()
  expect(compactions).toBe(0)

  await $.session.measure(measure(98) as never)
  await settle()
  expect(compactions).toBe(1)

  await $.session.measure(measure(99) as never)
  await settle()
  expect(compactions).toBe(1)

  await $.session.measure(measure(98.5, '2026-11-08T17:00:00Z') as never)
  await settle()
  expect(compactions).toBe(2)
})

test('tries again while a turn is running', async ($, on) => {
  let tries = 0
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    tries += 1
    if (tries < 3) throw new Error('a turn is running')
    return COMPACTED as never
  })

  await $.session.measure(measure(98) as never)
  await settle()
  expect(tries).toBe(3)
})

test('gives up on a window that never compacts', async ($, on) => {
  let tries = 0
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    tries += 1
    throw new Error('refused')
  })

  await $.session.measure(measure(98) as never)
  await settle()
  await settle()
  expect(tries).toBe(1200)
})

test('mid-turn: pauses at the next request, compacts, then resumes', async ($, on) => {
  const log: string[] = []
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    log.push('step')
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.abort', () => {
    log.push('abort')
    return { value: undefined }
  })
  on('turn.complete', () => {
    log.push('complete')
    return { text: '', reason: 'aborted' } as never
  })
  on('session.compact', () => {
    log.push('compact')
    return COMPACTED as never
  })
  on('prompt.submit', (_, e) => {
    log.push(`resume:${e.text.includes('继续') ? 'yes' : 'no'}`)
    return { text: e.text }
  })

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.session.measure(measure(98) as never)
  await settle()
  expect(log).toEqual([])

  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 3 } as never)) {
    // no chunks
  }
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as never)
  await settle()
  expect(log).toEqual(['abort', 'step', 'complete', 'compact', 'resume:yes'])
})

const pauseAndCompact = async ($: EngineInterface, on: On, compact: () => never) => {
  const resumes: string[] = []
  const lines: string[] = []
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.abort', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '', reason: 'aborted' }) as never)
  on('session.compact', compact)
  on('prompt.submit', (_, e) => {
    resumes.push(e.text)
    return { text: e.text }
  })

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.session.measure(measure(98) as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 3 } as never)) {
    // no chunks
  }
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as never)
  await settle()
  await settle()
  return { resumes, lines }
}

test('the resume message says the context was compacted when it was', async ($, on) => {
  const { resumes, lines } = await pauseAndCompact($, on, () => COMPACTED as never)
  expect(resumes).toHaveLength(1)
  expect(resumes[0]).toContain('并自动压缩了上下文')
  expect(lines).toEqual(['quota-compact：5 小时额度已达 98%，已自动压缩上下文（已暂停当前回合，并让 Claude 继续）'])
})

test('an idle compaction leaves a transcript line for the person', async ($, on) => {
  const lines: string[] = []
  let resumes = 0
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => COMPACTED as never)
  on('prompt.submit', (_, e) => {
    resumes += 1
    return { text: e.text }
  })

  await $.session.measure(measure(98) as never)
  await settle()
  expect(lines).toEqual(['quota-compact：5 小时额度已达 98%，已自动压缩上下文（没有暂停回合）'])
  expect(resumes).toBe(0)
})

test('the resume message says a skipped compaction did not happen', async ($, on) => {
  const { resumes } = await pauseAndCompact($, on, () => ({ skip: 'too short' }) as never)
  expect(resumes).toHaveLength(1)
  expect(resumes[0]).toContain('压缩被跳过（too short），上下文没有被压缩')
  expect(resumes[0]).not.toContain('并自动压缩了上下文')
})

test('the resume message says a failed compaction did not happen', async ($, on) => {
  const { resumes } = await pauseAndCompact($, on, () => {
    throw new Error('refused')
  })
  expect(resumes).toHaveLength(1)
  expect(resumes[0]).toContain('自动压缩未能完成，上下文没有被压缩')
  expect(resumes[0]).not.toContain('并自动压缩了上下文')
})

test('mid-turn: a turn that ends by itself is compacted without a resume', async ($, on) => {
  const log: string[] = []
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer, reason: e.reason }) as never)
  on('session.compact', () => {
    log.push('compact')
    return COMPACTED as never
  })
  on('prompt.submit', (_, e) => {
    log.push('resume')
    return { text: e.text }
  })

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.session.measure(measure(98) as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1, isAborted: false } as never)
  await settle()
  expect(log).toEqual(['compact'])
})

const usage = (percentUsed: number) => ({
  value: {
    startedAt: 0,
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: '2026-11-08T12:00:00Z' }],
  },
})

test('the command switches it off and sets the percentage, kept in the store', async ($, on) => {
  const store = new Map<string, unknown>()
  let compactions = 0
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined }
  })
  on('session.usage', () => usage(96) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    compactions += 1
    return COMPACTED as never
  })

  const off = await $.command.run({ command: 'quota-compact', args: 'off' } as never)
  expect(off.text).toContain('已停用')
  await $.session.measure(measure(99) as never)
  await settle()
  expect(compactions).toBe(0)

  const bad = await $.command.run({ command: 'quota-compact', args: 'on abc' } as never)
  expect(bad.text).toContain('用法')

  const on95 = await $.command.run({ command: 'quota-compact', args: 'on 95' } as never)
  expect(on95.text).toContain('已启用，阈值 95%')
  expect(store.get('settings')).toEqual({ isEnabled: true, threshold: 95 })
  // 96% is past the new 95%: the command itself starts the compaction.
  await settle()
  expect(compactions).toBe(1)

  const status = await $.command.run({ command: 'quota-compact', args: '' } as never)
  expect(status.text).toContain('已启用，阈值 95%')
})

test('a reopened session reads the stored setting', async ($, on) => {
  on('store.get', () => ({ value: { isEnabled: false, threshold: 90 } }))
  on('command.register', () => ({ value: { command: 'quota-compact' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usage(50) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const status = await $.command.run({ command: 'quota-compact', args: '' } as never)
  expect(status.text).toContain('已停用，阈值 90%')
})

test('a subagent of the main loop runs in the background while it is on', async ($, on) => {
  const seen: boolean[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.background)
    return { model: 'm' } as never
  })

  await $.agent.spawn({ prompt: 'p', background: false } as never).catch(() => undefined)
  await $.agent.spawn({ prompt: 'p', background: false, parentAgentId: 'a1' } as never).catch(() => undefined)
  expect(seen).toEqual([true, false])
})
