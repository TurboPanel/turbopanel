import { assertEquals } from '@std/assert'
import {
  allDatabasesAllowed,
  allDatabasesRefusalMessage,
  allDatabasesSwitches,
  loginDatabasesForApply,
} from './all-databases.ts'
import { parseManagedOrganizationDefaults } from './org-defaults.ts'
import { parseManagedSettingsBase } from './settings.ts'
import { listUsersReferencingDatabase } from './routes-helpers.ts'
import {
  applyManagedDefaultsPatch,
  parseManagedDefaultsPatch,
} from '../../client/organizations/routes-helpers.ts'

const test = Deno.test.bind(Deno)

test('defaults: organization on, cluster off, so a new cluster refuses', () => {
  const switches = allDatabasesSwitches({}, {})
  assertEquals(switches, { organization: true, cluster: false })
  assertEquals(allDatabasesAllowed(switches), false)
  assertEquals(allDatabasesRefusalMessage(switches)?.includes('Database Cluster'), true)
})

test('both switches must allow it, and the refusal names the one that is off', () => {
  const clusterOn = allDatabasesSwitches({}, { allowAllDatabasesLogins: true })
  assertEquals(allDatabasesAllowed(clusterOn), true)
  assertEquals(allDatabasesRefusalMessage(clusterOn), null)
  const orgOff = allDatabasesSwitches(
    { allowAllDatabasesLogins: false },
    { allowAllDatabasesLogins: true }
  )
  assertEquals(allDatabasesAllowed(orgOff), false)
  assertEquals(allDatabasesRefusalMessage(orgOff)?.includes('this organization'), true)
})

test('apply: an All Databases login gets the cluster list while allowed, its own picks otherwise', () => {
  const cluster = (active: boolean) => ({
    databases: ['a', 'b', 'mysql', 'a'],
    active,
    isReserved: (name: string) => name === 'mysql',
  })
  const login = { allDatabases: true, databases: ['a'] }
  assertEquals(loginDatabasesForApply(login, cluster(true)), ['a', 'b'])
  assertEquals(loginDatabasesForApply(login, cluster(false)), ['a'])
  assertEquals(loginDatabasesForApply({ allDatabases: false, databases: ['b'] }, cluster(true)), [
    'b',
  ])
})

test('the cluster switch is stored in the settings and must be a boolean', () => {
  assertEquals(
    parseManagedSettingsBase({ allowAllDatabasesLogins: true })?.allowAllDatabasesLogins,
    true
  )
  assertEquals(parseManagedSettingsBase({})?.allowAllDatabasesLogins, undefined)
  assertEquals(parseManagedSettingsBase({ allowAllDatabasesLogins: 'yes' }), null)
})

test('the organization switch is stored in the managed defaults', () => {
  assertEquals(parseManagedOrganizationDefaults({ allowAllDatabasesLogins: false }), {
    allowAllDatabasesLogins: false,
  })
  assertEquals(parseManagedOrganizationDefaults({ allowAllDatabasesLogins: 'no' }), {})
  const parsed = parseManagedDefaultsPatch({ allowAllDatabasesLogins: false })
  if (!parsed.ok) throw new Error('expected ok')
  assertEquals(applyManagedDefaultsPatch({ sslMode: 'require' }, parsed.patch), {
    sslMode: 'require',
    allowAllDatabasesLogins: false,
  })
  assertEquals(parseManagedDefaultsPatch({ allowAllDatabasesLogins: 1 }).ok, false)
})

test('switch off, an explicit pick on the dropped database still refuses the drop', () => {
  const logins = [{ username: 'bi', role: 'user', databases: ['app'], allDatabases: true }]
  assertEquals(listUsersReferencingDatabase(logins, 'app'), ['bi'])
})

test('apply never lists a database the cluster no longer has', () => {
  const cluster = { databases: ['b'], active: false, isReserved: () => false }
  assertEquals(loginDatabasesForApply({ allDatabases: true, databases: ['a', 'b'] }, cluster), [
    'b',
  ])
  // A normal login and an active All Databases login are unchanged.
  assertEquals(loginDatabasesForApply({ allDatabases: false, databases: ['a'] }, cluster), ['a'])
  assertEquals(
    loginDatabasesForApply({ allDatabases: true, databases: [] }, { ...cluster, active: true }),
    ['b']
  )
})
