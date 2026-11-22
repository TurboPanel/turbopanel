import { assertEquals } from '@std/assert'
import {
  evaluateTerminalGate,
  isValidLoginUser,
  isValidTerminalSize,
  type TerminalGateFacts,
} from './policy.ts'

const test = Deno.test.bind(Deno)

const ALL_TRUE: TerminalGateFacts = {
  switchOn: true,
  holdsPermission: true,
  containerOwned: true,
  containerRunning: true,
  daemonHasFeature: true,
}

test('terminal gate: every fact true opens', () => {
  assertEquals(evaluateTerminalGate(ALL_TRUE), { ok: true })
})

test('terminal gate: the switch always wins, whatever else holds', () => {
  const verdict = evaluateTerminalGate({ ...ALL_TRUE, switchOn: false })
  assertEquals(verdict, { ok: false, status: 403, code: 'terminal_disabled' })
  const allOff = evaluateTerminalGate({
    switchOn: false,
    holdsPermission: false,
    containerOwned: false,
    containerRunning: false,
    daemonHasFeature: false,
  })
  assertEquals(allOff, verdict)
})

test('terminal gate: refusals come in the documented order', () => {
  const cases: Array<[Partial<TerminalGateFacts>, number, string]> = [
    [{ holdsPermission: false }, 403, 'forbidden'],
    [{ containerOwned: false }, 404, 'container_not_found'],
    [{ containerRunning: false }, 409, 'container_not_running'],
    [{ daemonHasFeature: false }, 409, 'daemon_feature_missing'],
    [{ holdsPermission: false, containerOwned: false }, 403, 'forbidden'],
    [{ containerOwned: false, containerRunning: false }, 404, 'container_not_found'],
    [{ containerRunning: false, daemonHasFeature: false }, 409, 'container_not_running'],
  ]
  for (const [override, status, code] of cases) {
    const verdict: unknown = evaluateTerminalGate({ ...ALL_TRUE, ...override })
    assertEquals(verdict, { ok: false, status, code })
  }
})

test('login user and size validation', () => {
  for (const ok of ['root', 'app_1', 'www-data', '1000', '1000:1000']) {
    assertEquals(isValidLoginUser(ok), true, ok)
  }
  for (const bad of ['', 'Root', 'a b', '-x', 'a;b', '1:2:3', 5, null, 'x'.repeat(40)]) {
    assertEquals(isValidLoginUser(bad), false, String(bad))
  }
  assertEquals(isValidTerminalSize(80), true)
  assertEquals(isValidTerminalSize(1000), true)
  for (const bad of [0, 1001, -1, 1.5, '80', NaN]) {
    assertEquals(isValidTerminalSize(bad), false, String(bad))
  }
})
