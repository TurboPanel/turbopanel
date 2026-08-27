/**
 * Host-free coverage for task route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { parseCronCommand, parseCronSchedule } from '../../lib/cron.ts'
import {
  buildTaskPatchFields,
  parseTaskCommand,
  parseTaskCreateFields,
  parseTaskListFilters,
  parseTaskSchedule,
  parseTaskTimezone,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(
  query: Record<string, string | undefined> = {},
): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
    req: {
      query(name: string) {
        return query[name]
      },
    },
  } as unknown as Context<AppEnv>
}

async function expectScheduleInvalid(value: unknown): Promise<void> {
  const result = parseCronSchedule(value)
  if (result.ok) {
    throw new TypeError('expected parseCronSchedule to reject')
  }
  const response = parseTaskSchedule(mockContext(), value)
  if (!(response instanceof Response)) {
    throw new TypeError('expected task_schedule_invalid response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), {
    error: 'task_schedule_invalid',
    message: result.error,
  })
}

async function expectCommandInvalid(value: unknown): Promise<void> {
  const result = parseCronCommand(value)
  if (result.ok) {
    throw new TypeError('expected parseCronCommand to reject')
  }
  const response = parseTaskCommand(mockContext(), value)
  if (!(response instanceof Response)) {
    throw new TypeError('expected task_command_invalid response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), {
    error: 'task_command_invalid',
    message: result.error,
  })
}

test('parseTaskSchedule accepts a 5-field cron, an @hourly alias, and a dom+dow union', () => {
  assertEquals(parseTaskSchedule(mockContext(), '0 * * * *'), '0 * * * *')
  assertEquals(parseTaskSchedule(mockContext(), '  @hourly  '), '@hourly')
  assertEquals(parseTaskSchedule(mockContext(), '0 0 13 * 5'), '0 0 13 * 5')
})

test('parseTaskSchedule rejects @reboot, 4-field, and unsupported aliases', async () => {
  await expectScheduleInvalid('@reboot')
  await expectScheduleInvalid('0 * * *')
  await expectScheduleInvalid('@whenever')
})

test('parseTaskCommand rejects shell metacharacters and relative paths', async () => {
  await expectCommandInvalid('/usr/bin/true | cat')
  await expectCommandInvalid('true')
})

test('parseTaskTimezone accepts an allowed IANA zone and rejects unknown', async () => {
  assertEquals(parseTaskTimezone(mockContext(), 'America/New_York'), 'America/New_York')
  assertEquals(parseTaskTimezone(mockContext(), undefined), undefined)
  assertEquals(parseTaskTimezone(mockContext(), null), null)
  assertEquals(parseTaskTimezone(mockContext(), '  '), null)

  const rejected = parseTaskTimezone(mockContext(), 'Not/AZone')
  if (!(rejected instanceof Response)) {
    throw new TypeError('expected unknown timezone to be rejected')
  }
  assertEquals(rejected.status, 400)
  assertEquals(await rejected.json(), { error: 'Invalid request' })
})

test('buildTaskPatchFields rejects an empty patch and preserves null clears', async () => {
  const empty = buildTaskPatchFields(mockContext(), {})
  if (!(empty instanceof Response)) {
    throw new TypeError('expected empty patch to be rejected')
  }
  assertEquals(empty.status, 400)
  assertEquals(await empty.json(), { error: 'Invalid request' })

  const patch = buildTaskPatchFields(mockContext(), {
    timezone: null,
    timeoutSeconds: null,
  })
  if (patch instanceof Response) {
    throw new TypeError('expected a task patch')
  }
  assertEquals(patch.timezone, null)
  assertEquals(patch.timeoutSeconds, null)
})

test('parseTaskListFilters accepts one parent and rejects both', async () => {
  const serviceId = '11111111-1111-4111-8111-111111111111'
  const environmentId = '22222222-2222-4222-8222-222222222222'
  assertEquals(parseTaskListFilters(mockContext()), {})
  assertEquals(parseTaskListFilters(mockContext({ serviceId })), { serviceId })
  assertEquals(parseTaskListFilters(mockContext({ environmentId })), {
    environmentId,
  })

  const both = parseTaskListFilters(mockContext({ serviceId, environmentId }))
  if (!(both instanceof Response)) {
    throw new TypeError('expected both filters to be rejected')
  }
  assertEquals(both.status, 400)
  assertEquals(await both.json(), { error: 'Invalid request' })

  const invalid = parseTaskListFilters(mockContext({ serviceId: 'not-a-uuid' }))
  if (!(invalid instanceof Response)) {
    throw new TypeError('expected a malformed serviceId to be rejected')
  }
  assertEquals(invalid.status, 400)
})

test('parseTaskCreateFields accepts required fields and optional clears', async () => {
  const created = parseTaskCreateFields(mockContext(), {
    name: '  nightly  ',
    schedule: '0 0 * * *',
    command: '/usr/bin/true',
    timezone: null,
    timeoutSeconds: null,
    isEnabled: false,
    concurrencyPolicy: 'replace',
    metadata: { source: 'ui' },
    options: { retries: 1 },
  })
  if (created instanceof Response) {
    throw new TypeError('expected task create fields')
  }
  assertEquals(created.name, 'nightly')
  assertEquals(created.schedule, '0 0 * * *')
  assertEquals(created.command, '/usr/bin/true')
  assertEquals(created.timezone, null)
  assertEquals(created.timeoutSeconds, null)
  assertEquals(created.isEnabled, false)
  assertEquals(created.concurrencyPolicy, 'replace')
  assertEquals(created.metadata, { source: 'ui' })
  assertEquals(created.options, { retries: 1 })

  const rejected = parseTaskCreateFields(mockContext(), {
    name: 'nightly',
    schedule: '@reboot',
    command: '/usr/bin/true',
  })
  if (!(rejected instanceof Response)) {
    throw new TypeError('expected @reboot to be rejected')
  }
  assertEquals(rejected.status, 400)
})

test('parseTaskCreateFields and buildTaskPatchFields reject invalid optional fields', async () => {
  const missingName = parseTaskCreateFields(mockContext(), {
    schedule: '0 0 * * *',
    command: '/usr/bin/true',
  })
  if (!(missingName instanceof Response)) {
    throw new TypeError('expected a missing name to be rejected')
  }
  assertEquals(missingName.status, 400)

  const invalidTimeout = parseTaskCreateFields(mockContext(), {
    name: 'nightly',
    schedule: '0 0 * * *',
    command: '/usr/bin/true',
    timeoutSeconds: 0,
  })
  if (!(invalidTimeout instanceof Response)) {
    throw new TypeError('expected timeoutSeconds 0 to be rejected')
  }
  assertEquals(invalidTimeout.status, 400)

  const invalidPatch = buildTaskPatchFields(mockContext(), {
    schedule: '@reboot',
  })
  if (!(invalidPatch instanceof Response)) {
    throw new TypeError('expected an invalid patch schedule to be rejected')
  }
  assertEquals(invalidPatch.status, 400)
})
