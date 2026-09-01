import { describe, expect, it } from 'vitest'

import { AgentStateModel, SessionTitleModel, type Report } from '../src/state.js'

describe('AgentStateModel', () => {
  it('defaults to idle', () => {
    expect(new AgentStateModel().desired()).toEqual({ state: 'idle' })
  })

  it('reports working while any agent is running and idle when none are', () => {
    const model = new AgentStateModel()
    const primary = { id: 'primary' }
    const child = { id: 'child' }

    model.setRunning(primary, true)
    expect(model.desired()).toEqual({ state: 'working' })

    model.setRunning(child, true)
    expect(model.desired()).toEqual({ state: 'working' })

    model.setRunning(primary, false)
    expect(model.desired()).toEqual({ state: 'working' })

    model.setRunning(child, false)
    expect(model.desired()).toEqual({ state: 'idle' })
  })

  it('reports blocked ahead of working, until every interaction settles', () => {
    const model = new AgentStateModel()
    const agent = { id: 'primary' }
    model.setRunning(agent, true)

    model.setBlocked(true, 'fs:write')
    expect(model.desired()).toEqual({ state: 'blocked', message: 'fs:write' })

    model.setBlocked(true, 'exec')
    expect(model.desired()).toEqual({ state: 'blocked', message: 'exec' })

    model.setBlocked(false)
    // one still open -> still blocked
    expect(model.desired()).toEqual({ state: 'blocked', message: 'exec' })

    model.setBlocked(false)
    // all settled -> back to working
    expect(model.desired()).toEqual({ state: 'working' })
  })

  it('drops the message when the last blocked interaction closes', () => {
    const model = new AgentStateModel()
    model.setBlocked(true, 'ask')
    expect(model.desired()).toEqual({ state: 'blocked', message: 'ask' })
    model.setBlocked(false)
    expect(model.desired()).toEqual({ state: 'idle' })
  })

  it('never decrements below zero on a stale close', () => {
    const model = new AgentStateModel()
    model.setBlocked(false)
    expect(model.desired()).toEqual({ state: 'idle' })
  })

  it('does not smear a prior blocked message into later states', () => {
    const model = new AgentStateModel()
    const agent = { id: 'primary' }
    model.setRunning(agent, true)
    model.setBlocked(true, 'approve')
    model.setBlocked(false)
    const report: Report = model.desired()
    expect(report).toEqual({ state: 'working' })
  })
})

describe('SessionTitleModel', () => {
  it('publishes a pre-existing title when a session starts', () => {
    const model = new SessionTitleModel()
    expect(model.setSession('s1', 'Fix login')).toBe('Fix login')
    expect(model.desired()).toEqual({ title: 'Fix login' })
  })

  it('publishes nothing when the new session has no title yet', () => {
    const model = new SessionTitleModel()
    expect(model.setSession('s1', undefined)).toBeUndefined()
    expect(model.desired()).toBeUndefined()
  })

  it('ignores titles from other sessions', () => {
    const model = new SessionTitleModel()
    model.setSession('s1')
    expect(model.observeTitle('child-1', 'child work')).toBeUndefined()
    expect(model.desired()).toBeUndefined()
  })

  it('publishes tracked-session title events', () => {
    const model = new SessionTitleModel()
    model.setSession('s1')
    expect(model.observeTitle('s1', 'First prompt')).toBe('First prompt')
    expect(model.desired()).toEqual({ title: 'First prompt' })
  })

  it('adopts the first observed session when none was tracked', () => {
    const model = new SessionTitleModel()
    expect(model.observeTitle('s9', 'adopted')).toBe('adopted')
    expect(model.observeTitle('other', 'x')).toBeUndefined()
  })

  it('suppresses unchanged consecutive titles', () => {
    const model = new SessionTitleModel()
    expect(model.observeTitle('s1', 't')).toBe('t')
    expect(model.observeTitle('s1', 't')).toBeUndefined()
    expect(model.observeTitle('s1', 't2')).toBe('t2')
  })

  it('re-publishes an identical title after a session switch', () => {
    const model = new SessionTitleModel()
    expect(model.observeTitle('s1', 't')).toBe('t')
    expect(model.setSession('s2', 't')).toBe('t')
  })

  it('ignores empty and whitespace-only titles', () => {
    const model = new SessionTitleModel()
    expect(model.observeTitle('s1', '   ')).toBeUndefined()
    expect(model.desired()).toBeUndefined()
    expect(model.setSession('s1', '')).toBeUndefined()
  })
})
