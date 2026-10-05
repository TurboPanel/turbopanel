import { assertEquals } from '@std/assert'
import { repositoryUrlMatchesForgeHost } from './forge-clone-host.ts'

const test = Deno.test.bind(Deno)

test('a repository url on the forge host matches, whatever its spelling', () => {
  for (const url of [
    'https://github.com/acme/app.git',
    'https://GitHub.com/acme/app',
    'https://github.com:443/acme/app.git',
  ]) {
    assertEquals(repositoryUrlMatchesForgeHost(url, 'https://github.com'), true, url)
  }
})

test('any other host, port, scheme or userinfo trick is refused', () => {
  for (const url of [
    'https://attacker.example/acme/app.git',
    'https://github.com.attacker.example/acme/app.git',
    'https://github.com@attacker.example/acme/app.git',
    'https://attacker.example@github.com/acme/app.git',
    'https://github.com:8443/acme/app.git',
    'http://github.com/acme/app.git',
    'git@github.com:acme/app.git',
    'ssh://github.com/acme/app.git',
    'not a url',
  ]) {
    assertEquals(repositoryUrlMatchesForgeHost(url, 'https://github.com'), false, url)
  }
})

test('enterprise and self-managed hosts are compared with their port', () => {
  assertEquals(
    repositoryUrlMatchesForgeHost(
      'https://git.corp.test:8443/g/app.git',
      'https://git.corp.test:8443'
    ),
    true
  )
  assertEquals(
    repositoryUrlMatchesForgeHost('https://git.corp.test/g/app.git', 'https://git.corp.test:8443'),
    false
  )
  assertEquals(
    repositoryUrlMatchesForgeHost(
      'https://git.corp.test/g/app.git',
      'https://git.corp.test/gitlab'
    ),
    true
  )
})
