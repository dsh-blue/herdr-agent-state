/**
 * Pure models for the pane's Herdr reports: the semantic agent state, the
 * session display facts (title, model, context), and the small formatting
 * helpers they share.
 *
 * @module @dsh-blue/herdr-agent-state/state
 */

/**
 * Compact token count like the dsh TUI's status bar: `988`, `3.4k`, `12k`,
 * `1.0M`. Negative values clamp to zero.
 * @param {number} count
 * @returns {string}
 */
export function formatTokens(count) {
  const value = Math.max(0, Math.round(count))
  if (value < 1000) return String(value)
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1000000) return `${Math.round(value / 1000)}k`
  if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`
  return `${Math.round(value / 1000000)}M`
}

/**
 * Context occupancy from one `assistant/message` usage payload. The counts are
 * disjoint, so occupancy is the uncached input plus both cache fields.
 * `inputTokens` is the anchor: a sample without it carries no meaning.
 * @param {{ inputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number } | undefined} usage
 * @returns {number | undefined}
 */
export function sumUsageTokens(usage) {
  if (typeof usage?.inputTokens !== 'number') return undefined
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * The `used/window` context display, mirroring the dsh TUI status bar
 * (`34k/1.0M`). Bare `used` when the window is unknown; nothing before the
 * first usage sample.
 * @param {number | undefined} used
 * @param {number | undefined} contextWindow
 * @returns {string | undefined}
 */
export function formatContextUsage(used, contextWindow) {
  if (used === undefined) return undefined
  if (!Number.isFinite(contextWindow)) return formatTokens(used)
  return `${formatTokens(used)}/${formatTokens(contextWindow)}`
}

/** The state-label keys Herdr accepts on pane metadata. */
const STATE_LABEL_KEYS = ['idle', 'working', 'blocked', 'done', 'unknown']

/**
 * Keep only the five known state-label keys with non-blank text, trimmed.
 * @param {Record<string, string> | undefined} labels
 * @returns {Record<string, string> | undefined} undefined when nothing survives
 */
export function stateLabelsPayload(labels) {
  const payload = {}
  for (const key of STATE_LABEL_KEYS) {
    const value = labels?.[key]
    if (typeof value === 'string' && value.trim() !== '') payload[key] = value.trim()
  }
  return Object.keys(payload).length > 0 ? payload : undefined
}

/**
 * Pure semantic state model for the pane's Herdr state.
 */
export class AgentStateModel {
  constructor() {
    /** Agent objects reported as `running`, by identity (stable per session). */
    this.runningAgents = new Set()
    /** Number of open approval/question interactions. */
    this.blockedCount = 0
    /** Label of the most recently opened blocked interaction. */
    this.blockedMessage = undefined
    /** Tool calls that survived approval and are still running, by call id. */
    this.tools = new Map()
  }

  /**
   * Record one agent's running state; pass the same agent object on later events.
   * @param {unknown} agent
   * @param {boolean} running
   */
  setRunning(agent, running) {
    if (running) this.runningAgents.add(agent)
    else this.runningAgents.delete(agent)
  }

  /**
   * Open or close one blocked interaction. `active: true` opens a pending
   * approval/question and records `message`; `active: false` closes the most
   * recent one (never below zero).
   * @param {boolean} active
   * @param {string} [message]
   */
  setBlocked(active, message) {
    if (active) {
      this.blockedCount += 1
      if (message !== undefined) this.blockedMessage = message
      return
    }
    this.blockedCount = Math.max(0, this.blockedCount - 1)
    if (this.blockedCount === 0) this.blockedMessage = undefined
  }

  /**
   * A tool call survived approval and is about to run (`tools/execute`).
   * @param {string} callId
   * @param {string} name
   */
  toolStarted(callId, name) {
    this.tools.set(callId, name)
  }

  /**
   * The call settled (`tools/result`, or the execute waterfall's finally).
   * Idempotent; an unknown call id is a no-op.
   * @param {string} callId
   */
  toolFinished(callId) {
    this.tools.delete(callId)
  }

  /** The most recently started still-active tool name, or undefined. */
  currentTool() {
    const names = [...this.tools.values()]
    return names.length > 0 ? names[names.length - 1] : undefined
  }

  /**
   * The report derived from the current inputs. A blocked interaction labels
   * itself; a working pane labels itself with the current tool, when one is
   * active.
   * @returns {{ state: 'working' | 'blocked' | 'idle', message?: string }}
   */
  desired() {
    if (this.blockedCount > 0) {
      return this.blockedMessage !== undefined
        ? { state: 'blocked', message: this.blockedMessage }
        : { state: 'blocked' }
    }
    if (this.runningAgents.size > 0) {
      const tool = this.currentTool()
      return tool !== undefined ? { state: 'working', message: tool } : { state: 'working' }
    }
    return { state: 'idle' }
  }
}

/** The token keys this integration reports. */
const TOKEN_KEYS = ['model', 'ctx']

/** Shallow, undefined-tolerant equality for the small token/label payloads. */
function shallowEqual(a, b) {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if ((a[key] ?? undefined) !== (b[key] ?? undefined)) return false
  }
  return true
}

/**
 * Tracks which session's display facts are current — title, model, context
 * window, context occupancy — and decides, from session-start seeds and the
 * session-log feed, what changed enough to publish.
 */
export class SessionFactsModel {
  constructor() {
    /** Session identity from the latest agent/session-start. */
    this.sessionId = undefined
    /** Latest applicable title for that session. */
    this.title = undefined
    /** Latest model id from request/header config. */
    this.model = undefined
    /** Advertised context window in tokens, when known. */
    this.contextWindow = undefined
    /** Context occupancy from the latest assistant/message usage sample. */
    this.usedTokens = undefined
    /** Last title this model published (change tracking; resets per session). */
    this.lastReportedTitle = undefined
    /**
     * Last tokens snapshot this model published against (present-only). Kept
     * across sessions so a key that becomes unknown is null-cleared rather
     * than left stale on the pane.
     */
    this.lastReportedTokens = undefined
  }

  /**
   * The tracked session changed (agent/session-start). Adopts the new identity
   * and any pre-existing facts — a resumed session's log predates the plugin.
   * Title change tracking resets so an identical title re-publishes; token
   * tracking persists so stale keys are null-cleared.
   * @param {string | undefined} sessionId
   * @param {{ title?: string, model?: string, contextWindow?: number, usedTokens?: number }} [initial]
   * @returns {{ title?: string, tokens?: Record<string, string | null> } | undefined}
   */
  setSession(sessionId, initial = {}) {
    this.sessionId = sessionId
    this.title = initial?.title
    this.model = typeof initial?.model === 'string' && initial.model !== '' ? initial.model : undefined
    this.contextWindow = Number.isFinite(initial?.contextWindow) ? initial.contextWindow : undefined
    this.usedTokens = Number.isFinite(initial?.usedTokens) ? initial.usedTokens : undefined
    this.lastReportedTitle = undefined
    return this.takePublishable()
  }

  /**
   * Fold one session/event feed observation for the tracked session. Handles
   * `session/title`, `request/header`, `request/context`, and
   * `assistant/message`; other types and other sessions are ignored, and the
   * first observed session is adopted when none was recorded (plugin reloaded
   * mid-session). A usage-less assistant/message keeps the last occupancy.
   * @param {string | undefined} sessionId
   * @param {{ type: string, data?: unknown }} event
   * @returns {{ title?: string, tokens?: Record<string, string | null> } | undefined}
   */
  observeEvent(sessionId, event) {
    if (this.sessionId === undefined) this.sessionId = sessionId
    if (sessionId === undefined || sessionId !== this.sessionId) return undefined
    switch (event?.type) {
      case 'session/title': {
        const title = event.data?.title
        if (typeof title === 'string') this.title = title
        break
      }
      case 'request/header': {
        const model = event.data?.header?.config?.model
        if (typeof model === 'string' && model !== '') this.model = model
        break
      }
      case 'request/context': {
        const window = event.data?.contextWindow
        this.contextWindow = Number.isFinite(window) ? window : undefined
        break
      }
      case 'assistant/message': {
        const used = sumUsageTokens(event.data?.usage)
        if (used !== undefined) this.usedTokens = used
        break
      }
      default:
        return undefined
    }
    return this.takePublishable()
  }

  /** The publishable title, when it is a non-blank string. */
  desiredTitle() {
    return typeof this.title === 'string' && this.title.trim() !== '' ? this.title : undefined
  }

  /** The publishable tokens snapshot, present-only. */
  desiredTokens() {
    const tokens = {}
    if (this.model !== undefined) tokens.model = this.model
    const ctx = formatContextUsage(this.usedTokens, this.contextWindow)
    if (ctx !== undefined) tokens.ctx = ctx
    return tokens
  }

  /**
   * Consume the changed facts once, tracking them as reported. Token payloads
   * are key-level patches: a fresh value is sent as-is, a key that became
   * unknown after being reported is sent as null (explicit clear), and a key
   * never reported is omitted.
   * @returns {{ title?: string, tokens?: Record<string, string | null> } | undefined}
   */
  takePublishable() {
    const out = {}
    const title = this.desiredTitle()
    if (title !== undefined && title !== this.lastReportedTitle) {
      this.lastReportedTitle = title
      out.title = title
    }
    const current = this.desiredTokens()
    if (!shallowEqual(current, this.lastReportedTokens)) {
      const payload = {}
      for (const key of TOKEN_KEYS) {
        if (current[key] !== undefined) payload[key] = current[key]
        else if (this.lastReportedTokens?.[key] !== undefined) payload[key] = null
      }
      if (Object.keys(payload).length > 0) {
        this.lastReportedTokens = current
        out.tokens = payload
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
}
