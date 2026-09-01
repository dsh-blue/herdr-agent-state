/**
 * Herdr pane socket transport and reporter.
 *
 * Mirrors Herdr's own bundled Pi integration wire contract: one newline-delimited
 * JSON request per `pane.report_agent` / `pane.report_agent_session` /
 * `pane.release_agent` call — plus the display-only `pane.report_metadata` for
 * the pane title — a fresh single connection per request, a short timeout plus
 * one longer retry, and a failure that never rejects into the host process
 * (Herdr being absent must not disturb the dsh frontend).
 *
 * Only `node:net` is used.
 * @module @dsh-blue/herdr-agent-state/transport
 */

import net from 'node:net'

/** True when the process runs inside a Herdr pane that can receive reports. */
export function herdrEnabled(env) {
  return env.HERDR_ENV === '1' && Boolean(env.HERDR_SOCKET_PATH) && Boolean(env.HERDR_PANE_ID)
}

/** Resolve the socket endpoint, mapping Windows named pipes as Herdr does. */
export function socketEndpoint(env) {
  const raw = env.HERDR_SOCKET_PATH ?? ''
  return process.platform === 'win32' && raw !== '' ? `\\\\.\\pipe\\${raw}` : raw
}

/**
 * Deliver one request over a fresh single connection. A pane report is
 * fire-and-forget, so delivery means the request was written to Herdr's socket
 * (the write flushed), not that Herdr replied — Herdr's pane socket does not
 * necessarily acknowledge. Resolves `true` once the write flushes, `false` on
 * any failure. Never throws.
 *
 * @param {{ id: string, method: string, params: Record<string, unknown> }} request
 * @param {string} endpoint
 * @param {number} [timeoutMs]
 * @param {number} [retryMs]
 * @returns {Promise<boolean>}
 */
export function sendRequest(request, endpoint, timeoutMs = 500, retryMs = 1500) {
  return new Promise((resolve) => {
    const attempt = (delay, onSettled) => {
      let finished = false
      let timer
      const finish = (delivered) => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        client.destroy()
        onSettled(delivered)
      }

      const client = net.createConnection(endpoint)
      client.on('error', () => finish(false))
      client.on('end', () => finish(false))
      client.on('connect', () => {
        client.write(`${JSON.stringify(request)}\n`, () => finish(true))
      })
      timer = setTimeout(() => finish(false), delay)
      timer.unref?.()
    }

    attempt(timeoutMs, (delivered) => {
      if (delivered) resolve(true)
      else attempt(retryMs, (retried) => resolve(retried))
    })
  })
}

/**
 * Owns the seq counter, the single-flight latest-wins state queue, the session
 * reference, and the transport. Calling `publishState` coalesces bursts: only
 * the newest state is sent, and only when it differs from the last sent one.
 */
export class HerdrReporter {
  /**
   * @param {{ source: string, agent: string, reportSession: boolean, reportTitle?: boolean, env: Record<string, string | undefined> }} options
   */
  constructor(options) {
    this.source = options.source
    this.agent = options.agent
    this.reportSessionRef = options.reportSession
    this.reportTitleRef = options.reportTitle ?? false
    this.endpoint = socketEndpoint(options.env)
    this.paneId = options.env.HERDR_PANE_ID ?? ''
    // Wall-clock base keeps seq strictly increasing across process restarts.
    this.seq = Date.now() * 1000
    this.sessionId = undefined
    this.sendInFlight = false
    this.queued = undefined
    this.lastSent = undefined
    this.lastSentTitle = undefined
  }

  /** Record the session reference to attach to subsequent reports. */
  setSessionId(id) {
    this.sessionId = id
  }

  nextSeq() {
    this.seq += 1
    return this.seq
  }

  sessionParams() {
    if (this.reportSessionRef && this.sessionId !== undefined && this.sessionId !== '') {
      return { agent_session_id: this.sessionId }
    }
    return {}
  }

  send(request) {
    return sendRequest(request, this.endpoint)
  }

  /** Report the current pane state, coalescing bursts to a single latest value. */
  publishState(report, force = false) {
    if (!force && report.state === this.lastSent?.state && report.message === this.lastSent.message) {
      return
    }
    if (!force) this.lastSent = report
    this.queued = { ...report, seq: this.nextSeq() }
    void this.drain()
  }

  /** Report the pane's session reference; Herdr exposes it for restore. */
  reportSession(sessionStartSource) {
    const params = this.sessionParams()
    if (Object.keys(params).length === 0) return
    void this.send({
      id: `${this.source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: 'pane.report_agent_session',
      params: {
        pane_id: this.paneId,
        source: this.source,
        agent: this.agent,
        seq: this.nextSeq(),
        ...(sessionStartSource !== undefined ? { session_start_source: sessionStartSource } : {}),
        ...params,
      },
    })
  }

  /**
   * Report the dsh session title as display-only Herdr pane metadata. The
   * `agent` and `applies_to_source` guards scope the report to exactly the
   * moments this reporter holds the pane's lifecycle authority; `release()`
   * clears the title explicitly when that authority is given up.
   * @param {string | undefined} title
   */
  reportTitle(title) {
    if (!this.reportTitleRef) return
    if (typeof title !== 'string' || title.trim() === '') return
    if (title === this.lastSentTitle) return
    this.lastSentTitle = title
    void this.send({
      id: `${this.source}:title:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: 'pane.report_metadata',
      params: {
        pane_id: this.paneId,
        source: this.source,
        agent: this.agent,
        applies_to_source: this.source,
        title,
        seq: this.nextSeq(),
      },
    })
  }

  /**
   * Release this pane's lifecycle authority (on unload or process exit). The
   * guard on a reported title is checked at acceptance time, not continuously,
   * so a title this reporter set is cleared explicitly alongside the release.
   */
  release() {
    if (this.reportTitleRef && this.lastSentTitle !== undefined) {
      this.lastSentTitle = undefined
      void this.send({
        id: `${this.source}:title-clear:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method: 'pane.report_metadata',
        params: {
          pane_id: this.paneId,
          source: this.source,
          clear_title: true,
          seq: this.nextSeq(),
        },
      })
    }
    void this.send({
      id: `${this.source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: 'pane.release_agent',
      params: { pane_id: this.paneId, source: this.source, agent: this.agent },
    })
  }

  async drain() {
    if (this.sendInFlight) return
    this.sendInFlight = true
    try {
      while (this.queued !== undefined) {
        const next = this.queued
        this.queued = undefined
        const params = this.sessionParams()
        await this.send({
          id: `${this.source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
          method: 'pane.report_agent',
          params: {
            pane_id: this.paneId,
            source: this.source,
            agent: this.agent,
            state: next.state,
            ...(next.message !== undefined ? { message: next.message } : {}),
            seq: next.seq,
            ...params,
          },
        })
      }
    } finally {
      this.sendInFlight = false
      if (this.queued !== undefined) this.drain()
    }
  }
}
