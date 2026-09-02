/**
 * Herdr agent-state reporter for any dsh frontend.
 *
 * A Cordis function plugin that, when loaded inside a Herdr pane, reports the
 * pane's semantic state (working / blocked / idle, labeled with the current
 * tool while working), session reference and log path, and session display
 * facts — title, model, and context usage as pane metadata — to Herdr's pane
 * socket. It depends only on documented dsh extension points — agent lifecycle
 * events, the approval / user-question / tool-dispatch waterfalls, and the
 * session-log event feed — so it works in TUI, web, and headless profiles
 * alike. Outside a Herdr pane it is a strict no-op.
 *
 * Ships as plain ESM JavaScript (no build step) so `dsh plugin add` from a git
 * repo loads it directly without `prepare`/`lib`.
 *
 * @module @dsh-blue/herdr-agent-state
 */

import z from '@deepseek-ai/schemastery'

import { AgentStateModel, SessionFactsModel, stateLabelsPayload, sumUsageTokens } from './state.js'
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
  /**
   * Which title to publish as the Herdr pane title (display-only metadata).
   * `session` mirrors the dsh session title — first-prompt fallback,
   * LLM-generated, or pinned by `/rename`; `none` disables title reporting.
   */
  title: z.union([z.const('session'), z.const('none')]).default('session'),
  /** Whether to attach a human label to blocked reports. */
  message: z.union([z.const('tool'), z.const('none')]).default('tool'),
  /** Whether to attach the currently-executing tool name to working reports. */
  workingMessage: z.union([z.const('tool'), z.const('none')]).default('tool'),
  /**
   * Report the model id (`model`) and context usage (`ctx`, `used/window`
   * mirroring the dsh TUI status bar) as Herdr Agent-sidebar tokens.
   */
  tokens: z.union([z.const('auto'), z.const('none')]).default('auto'),
  /**
   * Display text per Herdr state; non-blank entries become pane state labels
   * (e.g. `{ working: 工作中, blocked: 等待确认 }`). All-blank disables them.
   */
  stateLabels: z.object({
    idle: z.string().default(''),
    working: z.string().default(''),
    blocked: z.string().default(''),
    done: z.string().default(''),
    unknown: z.string().default(''),
  }).default({}),
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
 * Seed model / context window / context occupancy from the replayed session
 * log. A resumed session's past events are constructor seeds that never re-fire
 * on the live session/event feed, so the initial facts come from the log.
 * @param {unknown} session
 * @returns {{ model?: string, contextWindow?: number, usedTokens?: number }}
 */
function seedSessionFacts(session) {
  try {
    const events = session?.events
    if (!Array.isArray(events)) return {}
    const model = events.findLast((e) => e.type === 'request/header')?.data?.header?.config?.model
    const context = events.findLast((e) => e.type === 'request/context')?.data
    const used = sumUsageTokens(events.findLast((e) => e.type === 'assistant/message')?.data?.usage)
    return {
      ...(typeof model === 'string' && model !== '' ? { model } : {}),
      ...(Number.isFinite(context?.contextWindow) ? { contextWindow: context.contextWindow } : {}),
      ...(used !== undefined ? { usedTokens: used } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Drive one pane's reporter from the live dsh event stream.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ agent: string, source: string, transport: 'socket' | 'cli', reportSession: boolean, title: 'session' | 'none', message: 'tool' | 'none', workingMessage: 'tool' | 'none', tokens: 'auto' | 'none', stateLabels: Record<string, string>, enabled: boolean }} config
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
    reportTitle: config.title !== 'none',
    reportTokens: config.tokens !== 'none',
    env,
  })
  const model = new AgentStateModel()
  const factsModel = new SessionFactsModel()
  const stateLabels = stateLabelsPayload(config.stateLabels)

  const publish = (force = false) => {
    const report = model.desired()
    if (report.state === 'blocked' && config.message === 'none') {
      reporter.publishState({ state: report.state }, force)
    } else if (report.state === 'working' && config.workingMessage === 'none') {
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
  // downstream decision, so the approval / question / tool flows are untouched.
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

  // The dispatch waterfall fires only for calls that survived approval, so the
  // label names a tool that is really about to run; tools/result (and the
  // finally below) close it by call id.
  ctx.on('tools/execute', async (exec, next) => {
    model.toolStarted(exec.callId, exec.name)
    publish()
    try {
      return await next()
    } finally {
      model.toolFinished(exec.callId)
      publish()
    }
  })

  ctx.on('tools/result', (exec) => {
    model.toolFinished(exec.callId)
    publish()
  })

  // Post-commit feed of appended session-log events; the facts model keeps
  // only title / model / context commits for the tracked session (child and
  // subagent sessions in this process are skipped by the session-id match).
  ctx.on('session/event', (session, event) => {
    switch (event?.type) {
      case 'session/title':
      case 'request/header':
      case 'request/context':
      case 'assistant/message':
        break
      default:
        return
    }
    reporter.reportMetadata(factsModel.observeEvent(session?.header?.id ?? session?.id, event))
  })

  ctx.on('agent/session-start', (payload) => {
    const session = payload.agent?.session
    const sessionId = session?.header?.id ?? undefined
    reporter.setSessionId(sessionId)

    // Absolute jsonl log path, when a locating persistence backend is mounted.
    let sessionPath
    try {
      const located = ctx.get('sessionPersistence')?.locate(session?.header)
      if (located?.kind === 'jsonl' && typeof located.path === 'string' && located.path !== '') {
        sessionPath = located.path
      }
    } catch {
      // Service not mounted in this host: the session id still reports.
    }
    reporter.setSessionPath(sessionPath)

    reporter.reportSession(payload.source)
    model.setRunning(payload.agent, false)
    publish(true)

    // Initial display facts: the title via the title service, the rest seeded
    // from the replayed log; static state labels ride the same request. Sent
    // after publish(true) so the authority claim precedes the guarded fields.
    let initialTitle
    try {
      initialTitle = ctx.get('sessionTitle')?.get(session)?.title
    } catch {
      // Service not mounted or session not live: the feed covers the rest.
    }
    reporter.reportMetadata({
      ...factsModel.setSession(sessionId, { title: initialTitle, ...seedSessionFacts(session) }),
      ...(stateLabels !== undefined ? { state_labels: stateLabels } : {}),
    })
  })

  ctx.effect(
    () => () => reporter.release(),
    'herdr-agent-state: release pane lifecycle authority on unload',
  )
  process.once('beforeExit', () => reporter.release())
}
