/**
 * Herdr agent-state reporter for any dsh frontend.
 *
 * A Cordis function plugin that, when loaded inside a Herdr pane, reports the
 * pane's semantic state (working / blocked / idle) and session reference to
 * Herdr's pane socket. It depends only on documented dsh extension points —
 * agent lifecycle events, the approval and user-question waterfalls — so it
 * works in TUI, web, and headless profiles alike. Outside a Herdr pane it is a
 * strict no-op.
 *
 * Ships as plain ESM JavaScript (no build step) so `dsh plugin add` from a git
 * repo loads it directly without `prepare`/`lib`.
 *
 * @module @dsh-blue/herdr-agent-state
 */

import z from '@deepseek-ai/schemastery'

import { AgentStateModel } from './state.js'
import { HerdrReporter, herdrEnabled } from './transport.js'

export const name = 'herdr-agent-state'

/** The plugin consumes no injected services; it reads the environment and events only. */
export const inject = []

/** Schemastery configuration for the plugin. */
export const Config = z.object({
  /**
   * Herdr agent label reported for the pane. Defaults to `dsh`; a host frontend
   * sets its own name (e.g. `blue`) by overriding this field in a patch overlay.
   */
  agent: z.string().default('dsh'),
  /**
   * Stable, unique integration source. Keep it constant so Herdr attributes the
   * pane's lifecycle authority to this reporter and so a future dsh-built
   * reporter can coexist under a different source.
   */
  source: z.string().default('herdr:dsh-agent-state'),
  /**
   * Transport to Herdr. `socket` speaks the pane socket directly; `cli` is a
   * declared-but-unimplemented fallback and is rejected at load.
   */
  transport: z.union([z.const('socket'), z.const('cli')]).default('socket'),
  /** Report the pane's session reference so Herdr can expose it for restore. */
  reportSession: z.boolean().default(true),
  /** Whether to attach a human label to blocked reports. */
  message: z.union([z.const('tool'), z.const('none')]).default('tool'),
  /** Kill-switch for coexisting with another reporter in the same tree. */
  enabled: z.boolean().default(true),
})

/** A concise human label for the leading question in a pending request. */
function questionLabel(questions) {
  const item = questions[0]
  const text = item?.title ?? item?.label ?? item?.placeholder ?? 'question'
  return questions.length > 1 ? `${text} (+${questions.length - 1} more)` : text
}

/**
 * Drive one pane's reporter from the live dsh event stream.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ agent: string, source: string, transport: 'socket' | 'cli', reportSession: boolean, message: 'tool' | 'none', enabled: boolean }} config
 */
export function apply(ctx, config) {
  if (!config.enabled) return
  if (config.transport !== 'socket') {
    throw new Error(`herdr-agent-state: transport "${String(config.transport)}" is not implemented; use 'socket'`)
  }

  const env = process.env
  if (!herdrEnabled(env)) return

  const reporter = new HerdrReporter({
    source: config.source,
    agent: config.agent,
    reportSession: config.reportSession,
    env,
  })
  const model = new AgentStateModel()

  const publish = (force = false) => {
    const report = model.desired()
    if (config.message === 'none' && report.state === 'blocked') {
      reporter.publishState({ state: report.state }, force)
    } else {
      reporter.publishState(report, force)
    }
  }

  ctx.on('agent/disposed', (payload) => {
    model.setRunning(payload.agent, false)
    publish()
  })

  ctx.on('agent/status', (payload) => {
    model.setRunning(payload.agent, payload.status === 'running')
    publish()
  })

  // Observers only: they delegate with `await next()` and never alter the
  // downstream decision, so the approval / question flow is untouched.
  ctx.on('approval/request', async (req, next) => {
    model.setBlocked(true, req.reason ?? req.toolName)
    publish()
    try {
      return await next()
    } finally {
      model.setBlocked(false)
      publish()
    }
  })

  ctx.on('user-questions/request', async (request, next) => {
    model.setBlocked(true, questionLabel(request.questions))
    publish()
    try {
      return await next()
    } finally {
      model.setBlocked(false)
      publish()
    }
  })

  ctx.on('agent/session-start', (payload) => {
    reporter.setSessionId(payload.agent?.session?.header?.id ?? undefined)
    reporter.reportSession(payload.source)
    model.setRunning(payload.agent, false)
    publish(true)
  })

  ctx.effect(
    () => () => reporter.release(),
    'herdr-agent-state: release pane lifecycle authority on unload',
  )
  process.once('beforeExit', () => reporter.release())
}
