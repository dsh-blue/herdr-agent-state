/**
 * Pure semantic state model: the pane-level Herdr state derived from dsh agent
 * lifecycle and interaction events. This module has no Cordis or dsh imports —
 * it is a testable value object that the plugin feeds from live events.
 *
 * A pane is `blocked` while any approval/question is awaiting a user decision,
 * `working` while any agent in the process is running, and otherwise `idle`.
 * @module @dsh-blue/herdr-agent-state/state
 */

/** The three semantic states Herdr's lifecycle authority understands. */
export type AgentState = 'working' | 'blocked' | 'idle'

/** One report the Herdr pane API accepts. */
export interface Report {
  state: AgentState
  /** Human label for the blocked condition (tool name / question summary). */
  message?: string
}

/**
 * Tracks the inputs that determine the pane's current state.
 *
 * Concurrent approvals and questions increment an internal counter so a nested
 * or overlapping pending interaction keeps the pane blocked until every one
 * settles. `runningAgents` holds the live agent objects whose status is
 * `running`, so subagents and the primary agent aggregate to a single
 * working/idle decision for the pane.
 */
export class AgentStateModel {
  /** Agent objects reported as `running`, by identity (stable per session). */
  private readonly runningAgents = new Set<unknown>()
  /** Number of open approval/question interactions. */
  private blockedCount = 0
  /** Label of the most recently opened blocked interaction. */
  private blockedMessage?: string

  /** Record one agent's running state; pass the same agent object on later events. */
  setRunning(agent: unknown, running: boolean): void {
    if (running) {
      this.runningAgents.add(agent)
    } else {
      this.runningAgents.delete(agent)
    }
  }

  /**
   * Open or close one blocked interaction. `active: true` opens a pending
   * approval/question and records `message`; `active: false` closes the most
   * recent one. Closing is idempotent-decrementing so a stale close cannot go
   * negative.
   */
  setBlocked(active: boolean, message?: string): void {
    if (active) {
      this.blockedCount += 1
      if (message !== undefined) {
        this.blockedMessage = message
      }
      return
    }
    this.blockedCount = Math.max(0, this.blockedCount - 1)
    if (this.blockedCount === 0) {
      this.blockedMessage = undefined
    }
  }

  /** The report derived from the current inputs. */
  desired(): Report {
    if (this.blockedCount > 0) {
      return { state: 'blocked', ...(this.blockedMessage !== undefined ? { message: this.blockedMessage } : {}) }
    }
    if (this.runningAgents.size > 0) {
      return { state: 'working' }
    }
    return { state: 'idle' }
  }
}
