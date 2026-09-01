import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HerdrReporter, herdrEnabled, sendRequest, socketEndpoint } from '../src/transport.js'

interface FakeServer {
  requests: Array<Record<string, unknown>>
  socketPath: string
  close(): Promise<void>
}

let active: FakeServer | undefined
let activeNet: net.Server | undefined
let dir: string

function startServer(): Promise<FakeServer> {
  dir = mkdtempSync(join(tmpdir(), 'herdr-state-'))
  const socketPath = join(dir, 'herdr.sock')
  const requests: Array<Record<string, unknown>> = []
  const srv = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) requests.push(JSON.parse(line) as Record<string, unknown>)
      }
      socket.end()
    })
  })
  return new Promise((resolve) => {
    srv.listen(socketPath, () => {
      activeNet = srv
      active = {
        requests,
        socketPath,
        close: () =>
          new Promise<void>((done) => {
            srv.close(() => {
              rmSync(dir, { recursive: true, force: true })
              done()
            })
          }),
      }
      resolve(active)
    })
  })
}

function env(paneId = 'p1'): Record<string, string> {
  return { HERDR_ENV: '1', HERDR_SOCKET_PATH: active!.socketPath, HERDR_PANE_ID: paneId }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  active = undefined
  activeNet = undefined
})

afterEach(async () => {
  if (activeNet) {
    await new Promise<void>((done) => activeNet!.close(() => done()))
  }
  if (active) {
    rmSync(active.socketPath, { force: true })
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('herdrEnabled / socketEndpoint', () => {
  it('enables only when the full Herdr env is present', () => {
    expect(herdrEnabled({})).toBe(false)
    expect(herdrEnabled({ HERDR_ENV: '1' })).toBe(false)
    expect(herdrEnabled({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/x' })).toBe(false)
    expect(herdrEnabled({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/x', HERDR_PANE_ID: 'p' })).toBe(true)
  })

  it('maps Windows named pipes on Windows', () => {
    if (process.platform === 'win32') {
      expect(socketEndpoint({ HERDR_SOCKET_PATH: 'foo' })).toBe('\\\\.\\pipe\\foo')
    } else {
      expect(socketEndpoint({ HERDR_SOCKET_PATH: '/x/herdr.sock' })).toBe('/x/herdr.sock')
    }
  })
})

describe('sendRequest', () => {
  it('delivers a newline-delimited JSON line and resolves true', async () => {
    await startServer()
    const request = { id: 'r1', method: 'pane.report_agent', params: { pane_id: 'p1' } }
    const delivered = await sendRequest(request, active!.socketPath)
    expect(delivered).toBe(true)
    await delay(10)
    expect(active!.requests).toHaveLength(1)
    expect(active!.requests[0]).toMatchObject({ method: 'pane.report_agent', params: { pane_id: 'p1' } })
  })

  it('resolves false (never throws) when Herdr is unreachable', async () => {
    const delivered = await sendRequest(
      { id: 'r1', method: 'pane.release_agent', params: {} },
      join(tmpdir(), 'nonexistent-herdr.sock'),
    )
    expect(delivered).toBe(false)
  })
})

describe('HerdrReporter', () => {
  it('publishes state with seq and session ref, coalescing bursts to the latest', async () => {
    await startServer()
    const reporter = new HerdrReporter({
      source: 'herdr:dsh-agent-state',
      agent: 'dsh',
      reportSession: true,
      env: env(),
    })
    reporter.setSessionId('sess-123')

    reporter.publishState({ state: 'working' })
    reporter.publishState({ state: 'blocked', message: 'fs:write' })
    reporter.publishState({ state: 'idle' })

    await delay(30)
    const states = active!.requests.filter((r) => r.method === 'pane.report_agent')
    expect(states.length).toBeGreaterThanOrEqual(1)
    expect(states.length).toBeLessThanOrEqual(2)
    const last = states[states.length - 1]!
    expect(last.params).toMatchObject({
      pane_id: 'p1',
      source: 'herdr:dsh-agent-state',
      agent: 'dsh',
      state: 'idle',
      agent_session_id: 'sess-123',
    })
    expect(typeof last.params?.seq).toBe('number')
  })

  it('keeps seq strictly increasing across reports', async () => {
    await startServer()
    const reporter = new HerdrReporter({ source: 's', agent: 'dsh', reportSession: false, env: env() })
    reporter.publishState({ state: 'working' })
    await delay(10)
    reporter.publishState({ state: 'idle' })
    await delay(10)
    const seqs = active!.requests.map((r) => r.params?.seq as number)
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
    }
  })

  it('reports the session reference with its start source', async () => {
    await startServer()
    const reporter = new HerdrReporter({ source: 's', agent: 'blue', reportSession: true, env: env() })
    reporter.setSessionId('sess-9')
    reporter.reportSession('resume')
    await delay(10)
    const sessionReport = active!.requests.find((r) => r.method === 'pane.report_agent_session')
    expect(sessionReport?.params).toMatchObject({
      pane_id: 'p1',
      source: 's',
      agent: 'blue',
      agent_session_id: 'sess-9',
      session_start_source: 'resume',
    })
  })

  it('releases pane authority', async () => {
    await startServer()
    const reporter = new HerdrReporter({ source: 's', agent: 'dsh', reportSession: true, env: env() })
    reporter.release()
    await delay(10)
    const releaseReport = active!.requests.find((r) => r.method === 'pane.release_agent')
    expect(releaseReport?.params).toMatchObject({ pane_id: 'p1', source: 's', agent: 'dsh' })
  })

  it('omits the session ref when reportSession is disabled', async () => {
    await startServer()
    const reporter = new HerdrReporter({ source: 's', agent: 'dsh', reportSession: false, env: env() })
    reporter.setSessionId('sess-1')
    reporter.publishState({ state: 'working' })
    await delay(10)
    const last = active!.requests[active!.requests.length - 1]!
    expect(last.params).not.toHaveProperty('agent_session_id')
  })
})
