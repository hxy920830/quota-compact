import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

const COMMAND = 'quota-compact'
const SETTINGS_KEY = 'settings'
const DEFAULTS: Settings = { isEnabled: true, threshold: 98 }
const FIRST_TRY_MS = 1_000
const RETRY_MS = 3_000
// About an hour of retries; a window that still has not compacted is left be.
const MAX_TRIES = 1_200

type Settings = { isEnabled: boolean; threshold: number }

const doneFor = atom({ plugin: 'quota-compact', key: 'doneFor' } as const, null)

// Kept in $.store: one setting for every session, this one reopened included.
let settings: Settings = DEFAULTS
// The main loop's running turn, if any.
let mainTurn: string | null = null
// A window to compact at the running turn's next model request.
let armed: string | null = null
// The window whose turn this mod aborted: compact it, then resume.
let abortedFor: string | null = null
// The window waiting for its compaction, by its reset time.
let pending: string | null = null
let shouldResume = false
let tries = 0
let timer: Timer | null = null
let isRunning = false

function toSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return DEFAULTS
  const { isEnabled, threshold } = value as Partial<Settings>
  return {
    isEnabled: typeof isEnabled === 'boolean' ? isEnabled : DEFAULTS.isEnabled,
    threshold:
      typeof threshold === 'number' && threshold > 0 && threshold <= 100
        ? threshold
        : DEFAULTS.threshold,
  }
}

async function loadSettings($: EngineInterface) {
  settings = toSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
}

function resumeText(outcome: string) {
  return `5 小时额度已达 ${settings.threshold}%，刚才的回合已暂停${outcome}。请从中断处继续之前的任务。`
}

function schedule($: EngineInterface, ms: number) {
  if (timer !== null) return
  timer = $.clock.after(ms, () => {
    timer = null
    void attempt($)
  })
}

function queue($: EngineInterface, key: string, resume: boolean) {
  pending = key
  shouldResume = resume
  tries = 0
  schedule($, FIRST_TRY_MS)
}

async function finish($: EngineInterface, key: string, note: string, outcome: string) {
  pending = null
  await update($, doneFor, () => key).catch(() => undefined)
  $.ui.toast(note)
  // A dim transcript line that stays on screen; the model never reads it.
  $.ui.log(
    `quota-compact：${note}${shouldResume ? '（已暂停当前回合，并让 Claude 继续）' : '（没有暂停回合）'}`,
  )
  if (shouldResume) {
    shouldResume = false
    await $.prompt.submit({ text: resumeText(outcome) })
  }
}

async function attempt($: EngineInterface) {
  if (pending === null || isRunning) return
  const key = pending
  isRunning = true
  tries += 1
  try {
    // Rejects while a turn runs: the retry waits for the gap between turns.
    const result = await $.session.compact()
    if (result.skip === undefined) {
      await finish(
        $,
        key,
        `5 小时额度已达 ${settings.threshold}%，已自动压缩上下文`,
        '并自动压缩了上下文',
      )
    } else {
      await finish(
        $,
        key,
        `5 小时额度已达 ${settings.threshold}%，压缩被跳过：${result.skip}`,
        `，但压缩被跳过（${result.skip}），上下文没有被压缩`,
      )
    }
  } catch {
    if (pending === key && tries < MAX_TRIES) {
      schedule($, RETRY_MS)
    } else if (pending === key) {
      await finish(
        $,
        key,
        `5 小时额度已达 ${settings.threshold}%，自动压缩未能完成`,
        '，但自动压缩未能完成，上下文没有被压缩',
      )
    }
  } finally {
    isRunning = false
  }
}

async function check($: EngineInterface, percentUsed: number, resetsAt?: string) {
  if (!settings.isEnabled || percentUsed < settings.threshold) return
  const key = resetsAt ?? 'five_hour'
  const isHandled = pending === key || armed === key || abortedFor === key
  if (isHandled || (await read($, doneFor)) === key) return
  if (mainTurn === null) queue($, key, false)
  else armed = key
}

function parseSwitch(word: string): boolean | undefined {
  const w = word.toLowerCase()
  if (['on', 'enable', 'enabled', 'true', '1', '启用', '开启', '开'].includes(w)) return true
  if (['off', 'disable', 'disabled', 'false', '0', '停用', '关闭', '关'].includes(w)) return false
  return undefined
}

function parsePercent(word: string): number | undefined {
  const n = Number(word.replace(/%$/, ''))
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 10) / 10 : undefined
}

const USAGE = `用法：/${COMMAND} [on|off] [百分比]，例如 /${COMMAND} on 95、/${COMMAND} off；不带参数查看当前设置`

export const register: Register = on => {
  settings = DEFAULTS
  mainTurn = null
  armed = null
  abortedFor = null
  pending = null
  shouldResume = false
  tries = 0
  timer = null
  isRunning = false

  on('session.start', async ($, e, next) => {
    await loadSettings($)
    await $.command.register({
      name: COMMAND,
      description: '5 小时额度到达设定百分比时自动压缩上下文：启用/停用与百分比',
      argumentHint: '[on|off] [百分比]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await loadSettings($)
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    let next = settings

    if (words.length > 2) return { text: USAGE }
    if (words.length > 0) {
      const [first = '', second] = words
      const isEnabled = parseSwitch(first)
      const firstPercent = isEnabled === undefined ? parsePercent(first) : undefined
      const percent = second === undefined ? firstPercent : parsePercent(second)
      const isBad =
        (isEnabled === undefined && firstPercent === undefined) ||
        (second !== undefined && (isEnabled === undefined || percent === undefined))
      if (isBad) return { text: USAGE }

      next = {
        isEnabled: isEnabled ?? settings.isEnabled,
        threshold: percent ?? settings.threshold,
      }
      await $.store.set(SETTINGS_KEY, next)
      settings = next
      if (!next.isEnabled) {
        armed = null
        pending = null
        shouldResume = false
      }
    }

    const window = (await $.session.usage()).rateLimits.find(
      limit => limit.kind === 'five_hour',
    )
    if (window !== undefined) await check($, window.percentUsed, window.resetsAt)

    const state = next.isEnabled ? '已启用' : '已停用'
    const used = window === undefined ? '暂无数据' : `${window.percentUsed}%`
    return {
      text: `quota-compact ${state}，阈值 ${next.threshold}%（当前 5 小时额度：${used}）。设置对所有会话生效，重开会话后仍保留。`,
    }
  }).catch(() => ({ text: `/${COMMAND} 出错了，设置未改变` }))

  on('turn.start', (_, e, next) => {
    if (e.agentId === undefined) mainTurn = e.turnId
    return next(e)
  })

  // A subagent of the main loop runs in the background while the mod is on, so
  // the main turn never waits on it and can pause and compact while it works.
  on('agent.spawn', (_, e, next) =>
    settings.isEnabled && e.parentAgentId === undefined && !e.background
      ? next({ ...e, background: true })
      : next(e),
  ).catch(($, e, next) => next(e))

  // The safe point: the tools of the last step have finished, the next model
  // request has not gone out. Ending the turn here cuts no tool short.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && armed !== null && e.turnId === mainTurn) {
      abortedFor = armed
      armed = null
      $.ui.toast(`5 小时额度已达 ${settings.threshold}%，暂停当前回合以压缩上下文`)
      await $.turn.abort({ turnId: e.turnId })
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    mainTurn = null

    if (abortedFor !== null) {
      const key = abortedFor
      abortedFor = null
      queue($, key, true)
    } else if (armed !== null) {
      // The turn ended by itself before another request: compact, no resume.
      const key = armed
      armed = null
      queue($, key, false)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const window = e.rateLimits.find(limit => limit.kind === 'five_hour')
    if (window !== undefined) await check($, window.percentUsed, window.resetsAt)
    return result
  })
}
