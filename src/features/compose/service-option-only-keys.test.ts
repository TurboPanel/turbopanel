import { assertEquals } from '@std/assert'
import { collectServiceOptionOnlyKeyIssues } from './service-option-only-keys.ts'
import { emptyComposeDocument } from './types.ts'
import { validateComposeDocument } from './validate.ts'

const test = Deno.test.bind(Deno)

const services = {
  web: {
    image: 'php:8',
    'x-turbopanel': {
      serviceKind: 'site',
      workers: [{ name: 'queue', command: 'php artisan queue:work' }],
      postDeployCommands: ['php artisan migrate'],
    },
  },
}

test('collectServiceOptionOnlyKeyIssues names each refused key', () => {
  assertEquals(
    collectServiceOptionOnlyKeyIssues(services).map((issue) => issue.path),
    ['services.web.x-turbopanel.workers', 'services.web.x-turbopanel.postDeployCommands']
  )
})

test('validateComposeDocument refuses workers in x-turbopanel', () => {
  const result = validateComposeDocument({
    ...emptyComposeDocument(),
    data: { services },
  })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((issue) => issue.path === 'services.web.x-turbopanel.workers'),
      true
    )
  }
})
