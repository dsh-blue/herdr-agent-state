import { describe, expect, it } from 'vitest'

import { AgentStateModel, type Report } from '../src/state.js'

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
