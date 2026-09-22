import { assert, assertEquals } from '@std/assert'
import { afterEach, describe, it } from '@std/testing/bdd'
import {
  getExecutionLogSealSink,
  resetExecutionLogSealSinkForTests,
  sealExecutionLogOnTerminal,
  setExecutionLogSealSink,
} from './seal-on-terminal.ts'

describe('execution log seal sink', () => {
  afterEach(() => {
    resetExecutionLogSealSinkForTests()
  })

  it('is unset until a runtime registers one', () => {
    assertEquals(getExecutionLogSealSink(), null)
  })

  it('is a no-op when no sink is registered', async () => {
    await sealExecutionLogOnTerminal('cmd-1')
  })

  it('seals through the registered sink', async () => {
    const sealed: string[] = []
    setExecutionLogSealSink({
      seal(commandId) {
        sealed.push(commandId)
        return Promise.resolve({ bytes: 0 })
      },
    })

    await sealExecutionLogOnTerminal('cmd-1')
    assertEquals(sealed, ['cmd-1'])
  })

  it('prefers an explicitly passed sink over the registered one', async () => {
    const registered: string[] = []
    const explicit: string[] = []
    setExecutionLogSealSink({
      seal(commandId) {
        registered.push(commandId)
        return Promise.resolve(null)
      },
    })

    await sealExecutionLogOnTerminal('cmd-1', {
      seal(commandId) {
        explicit.push(commandId)
        return Promise.resolve(null)
      },
    })
    assertEquals(registered, [])
    assertEquals(explicit, ['cmd-1'])
  })

  it('never lets a storage failure surface into the command transition', async () => {
    setExecutionLogSealSink({
      seal() {
        return Promise.reject(new Error('bucket unreachable'))
      },
    })
    // Resolving (not throwing) is the whole contract — a failed seal must not
    // fail an otherwise-successful command.
    await sealExecutionLogOnTerminal('cmd-1')
  })

  it('swallows a synchronous throw from a sink too', async () => {
    setExecutionLogSealSink({
      seal(): never {
        throw new Error('sync boom')
      },
    })
    await sealExecutionLogOnTerminal('cmd-1')
  })

  it('can be cleared', () => {
    setExecutionLogSealSink({ seal: () => Promise.resolve(null) })
    assert(getExecutionLogSealSink() !== null)
    setExecutionLogSealSink(null)
    assertEquals(getExecutionLogSealSink(), null)
  })
})
