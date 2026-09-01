/**
 * Herdr pane socket transport and reporter.
 *
 * Mirrors Herdr's own bundled Pi integration wire contract: one newline-delimited
 * JSON request per `pane.report_agent` / `pane.report_agent_session` /
 * `pane.release_agent` call, a fresh single connection per request, a short
 * timeout plus one longer retry, and a failure that never rejects into the host
 * process (Herdr being absent must not disturb the dsh frontend).
 *
 * Only `node:net` is used, so the module has no Cordis or dsh dependency.
 * @module @dsh-blue/herdr-agent-state/transport
 */

import net from 'node:net'

import type { Report } from './state.js'

/** The environment variables Herdr exports into an agent pane. */
export interface HerdrEnv {
  readonly HERDR_ENV?: string
  readonly HERDR_SOCKET_PATH?: string
  readonly HERDR_PANE_ID?: string
}

/** Options for the reporter, resolved from plugin config and the environment. */
export interface ReporterOptions {
  source: string
  agent: string
  reportSession: boolean
  env: HerdrEnv
}

/** One JSON-RPC-style request body Herdr's pane socket understands. */
interface PaneRequest {
  id: string
  method: 'pane.report_agent' | 'pane.report_agent_session' | 'pane.release_agent'
  params: Record<string, unknown>
}

/** True when the process runs inside a Herdr pane that can receive reports. */
export function herdrEnabled(env: HerdrEnv): boolean {
  return env.HERDR_ENV === '1' && Boolean(env.HERDR_SOCKET_PATH) && Boolean(env.HERDR_PANE_ID)
}

/** Resolve the socket endpoint, mapping Windows named pipes as Herdr does. */
export function socketEndpoint(env: HerdrEnv): string {
  const raw = env.HERDR_SOCKET_PATH ?? ''
  return process.platform === 'win32' && raw !== '' ? `\\\\.\\pipe\\${raw}` : raw
}

/**
 * Deliver one request over a fresh single connection. Resolves `true` when the
 * socket accepts it; `false` on any failure. Never throws.
 */
export function sendRequest(
  request: PaneRequest,
  endpoint: string,
  timeoutMs = 500,
  retryMs = 1500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = (delay: number, onSettled: (delivered: boolean) => void): void => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (delivered: boolean): void => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        client.destroy()
        onSettled(delivered)
      }

      const client = net.createConnection(endpoint)
      client.on('error', () => finish(false))
      client.on('connect', () => client.write(`${JSON.stringify(request)}\n`))
      client.on('data', () => finish(true))
      client.on('end', () => finish(false))
      timer = setTimeout(() => finish(false), delay)
      timer.unref?.()
    }

    attempt(timeoutMs, (delivered) => {
      if (delivered) {
        resolve(true)
      } else {
        attempt(retryMs, (retried) => resolve(retried))
      }
    })
  })
}

/**
 * Owns the seq counter, the single-flight latest-wins state queue, the session
 * reference, and the transport. Calling `publishState` coalesces bursts: only
 * the newest state is sent, and only when it differs from the last sent one.
 */
export class HerdrReporter {
  private readonly source: string
  private readonly agent: string
  private readonly reportSessionRef: boolean
  private readonly endpoint: string
  private readonly paneId: string
  private seq: number
  private sessionId?: string
  private sendInFlight = false
  private queued?: Report & { seq: number }
  private lastSent?: Report

  constructor(options: ReporterOptions) {
    this.source = options.source
    this.agent = options.agent
    this.reportSessionRef = options.reportSession
    this.endpoint = socketEndpoint(options.env)
    this.paneId = options.env.HERDR_PANE_ID ?? ''
    // Wall-clock base keeps seq strictly increasing across process restarts.
    this.seq = Date.now() * 1000
  }

  /** Record the session reference to attach to subsequent reports. */
  setSessionId(id?: string): void {
    this.sessionId = id
  }

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  private sessionParams(): Record<string, unknown> {
    if (this.reportSessionRef && this.sessionId !== undefined && this.sessionId !== '') {
      return { agent_session_id: this.sessionId }
    }
    return {}
  }

  private send(request: PaneRequest): Promise<boolean> {
    return sendRequest(request, this.endpoint)
  }

  /** Report the current pane state, coalescing bursts to a single latest value. */
  publishState(report: Report, force = false): void {
    if (!force && report.state === this.lastSent?.state && report.message === this.lastSent.message) {
      return
    }
    if (!force) {
      this.lastSent = report
    }
    this.queued = { ...report, seq: this.nextSeq() }
    void this.drain()
  }

  /** Report the pane's session reference; Herdr exposes it for restore. */
  reportSession(sessionStartSource?: string): void {
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

  /** Release this pane's lifecycle authority (on unload or process exit). */
  release(): void {
    void this.send({
      id: `${this.source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: 'pane.release_agent',
      params: {
        pane_id: this.paneId,
        source: this.source,
        agent: this.agent,
      },
    })
  }

  private async drain(): Promise<void> {
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
