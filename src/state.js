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
