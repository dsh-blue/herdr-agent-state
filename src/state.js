/**
 * Pure semantic state model for the pane's Herdr state.
 *
 * @module @dsh-blue/herdr-agent-state/state
 */

export class AgentStateModel {
  constructor() {
    /** Agent objects reported as `running`, by identity (stable per session). */
    this.runningAgents = new Set()
    /** Number of open approval/question interactions. */
    this.blockedCount = 0
    /** Label of the most recently opened blocked interaction. */
    this.blockedMessage = undefined
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
   * The report derived from the current inputs.
   * @returns {{ state: 'working' | 'blocked' | 'idle', message?: string }}
   */
  desired() {
    if (this.blockedCount > 0) {
      return this.blockedMessage !== undefined
        ? { state: 'blocked', message: this.blockedMessage }
        : { state: 'blocked' }
    }
    if (this.runningAgents.size > 0) return { state: 'working' }
    return { state: 'idle' }
  }
}

/**
 * Tracks which session's title is current and the latest applicable title,
 * deciding when a title observation should be published.
 */
export class SessionTitleModel {
  constructor() {
    /** Session identity from the latest agent/session-start. */
    this.sessionId = undefined
    /** Latest applicable title for that session. */
    this.title = undefined
    /** Last title this model told the caller to publish (change tracking). */
    this.lastReported = undefined
  }

  /**
   * The tracked session changed (agent/session-start). Adopts the new identity
   * and any pre-existing title (a resumed session's title predates the plugin),
   * resetting change tracking so an identical title re-publishes.
   * @param {string | undefined} sessionId
   * @param {string | undefined} [initialTitle]
   * @returns {string | undefined} the title to publish now, if any
   */
  setSession(sessionId, initialTitle) {
    this.sessionId = sessionId
    this.title = initialTitle
    this.lastReported = undefined
    return this.takePublishable()
  }

  /**
   * One session/title observation from the session/event firehose. Ignores
   * other sessions' titles and unchanged text; adopts the first observed
   * session when none was recorded (plugin reloaded mid-session).
   * @param {string | undefined} sessionId
   * @param {string} title
   * @returns {string | undefined} the title to publish now, if changed
   */
  observeTitle(sessionId, title) {
    if (this.sessionId === undefined) this.sessionId = sessionId
    if (sessionId === undefined || sessionId !== this.sessionId) return undefined
    this.title = title
    return this.takePublishable()
  }

  /**
   * The report derived from the current inputs.
   * @returns {{ title: string } | undefined}
   */
  desired() {
    return typeof this.title === 'string' && this.title.trim() !== ''
      ? { title: this.title }
      : undefined
  }

  /** Consume the desired report once, tracking it as reported. */
  takePublishable() {
    const report = this.desired()
    if (report === undefined || report.title === this.lastReported) return undefined
    this.lastReported = report.title
    return report.title
  }
}
