import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  parseCompleteInstallBodyRaw,
  parseInstallHostCredentialsBody,
} from './parse-body.ts'

it('parseInstallHostCredentialsBody accepts trimmed username and non-empty password', () => {
  const result = parseInstallHostCredentialsBody({
    username: ' root ',
    password: 'host-secret',
  })
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.value.username, ' root ')
    assertEquals(result.value.password, 'host-secret')
  }
})

it('parseInstallHostCredentialsBody rejects non-objects and missing fields', () => {
  assertEquals(parseInstallHostCredentialsBody(null).ok, false)
  assertEquals(parseInstallHostCredentialsBody([]).ok, false)
  assertEquals(parseInstallHostCredentialsBody({ username: 'root' }).ok, false)
  assertEquals(parseInstallHostCredentialsBody({ password: 'x' }).ok, false)
  assertEquals(
    parseInstallHostCredentialsBody({ username: '   ', password: 'x' }).ok,
    false,
  )
  assertEquals(
    parseInstallHostCredentialsBody({ username: 'root', password: '' }).ok,
    false,
  )
})

it('parseCompleteInstallBodyRaw accepts host and superadmin fields', () => {
  const result = parseCompleteInstallBodyRaw({
    username: 'sudo-user',
    password: 'host-secret',
    superadminEmail: 'admin@203.0.113.10.example',
    superadminPassword: 'Sup3r-secret!',
  })
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.value.superadminEmail, 'admin@203.0.113.10.example')
    assertEquals(result.value.superadminPassword, 'Sup3r-secret!')
  }
})

it('parseCompleteInstallBodyRaw rejects incomplete payloads', () => {
  assertEquals(parseCompleteInstallBodyRaw(null).ok, false)
  assertEquals(
    parseCompleteInstallBodyRaw({
      username: 'root',
      password: 'host-secret',
      superadminEmail: 'admin@example.com',
    }).ok,
    false,
  )
  assertEquals(
    parseCompleteInstallBodyRaw({
      username: '',
      password: 'host-secret',
      superadminEmail: 'admin@example.com',
      superadminPassword: 'Sup3r-secret!',
    }).ok,
    false,
  )
})
