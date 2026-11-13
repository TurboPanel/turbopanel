import { assertEquals } from '@std/assert'
import { buildServiceVariablesViews } from './service-variables-view.ts'

const test = Deno.test.bind(Deno)

test('lists variables by the name a person set, with build and runtime flags', () => {
  const views = buildServiceVariablesViews({
    runtimeAssignments: new Map([
      [
        'website',
        [
          {
            name: 'NODE_OPTIONS',
            key: 'NODE_OPTIONS',
            isSecret: false,
            value: '--max-old-space-size=2048',
            source: 'service',
          },
          {
            name: 'API_TOKEN',
            key: 'TOKEN',
            isSecret: true,
            value: null,
            source: 'project',
          },
        ],
      ],
    ]),
    buildAssignments: new Map([
      [
        'website',
        [
          {
            name: 'NODE_OPTIONS',
            key: 'NODE_OPTIONS',
            value: '--max-old-space-size=2048',
            source: 'service',
          },
          {
            name: 'BUILD_ONLY',
            key: 'BUILD_ONLY',
            value: '1',
            source: 'project',
          },
        ],
      ],
    ]),
    secretPlan: [
      {
        key: 'TOKEN',
        composeServiceName: 'website',
        source: 's',
        target: 't',
        relativePath: 'r',
        forBuild: true,
        forRuntime: true,
      },
      {
        key: 'NPM_AUTH',
        composeServiceName: 'website',
        source: 's',
        target: 't',
        relativePath: 'r',
        forBuild: true,
        forRuntime: false,
      },
    ],
  })
  assertEquals(views, [
    {
      composeServiceName: 'website',
      variables: [
        {
          name: 'API_TOKEN',
          source: 'project',
          isSecret: true,
          value: null,
          forBuild: true,
          forRuntime: true,
        },
        {
          name: 'BUILD_ONLY',
          source: 'project',
          isSecret: false,
          value: '1',
          forBuild: true,
          forRuntime: false,
        },
        {
          name: 'NODE_OPTIONS',
          source: 'service',
          isSecret: false,
          value: '--max-old-space-size=2048',
          forBuild: true,
          forRuntime: true,
        },
        {
          name: 'NPM_AUTH',
          source: 'unknown',
          isSecret: true,
          value: null,
          forBuild: true,
          forRuntime: false,
        },
      ],
    },
  ])
})

test('never carries a secret value and skips services with nothing', () => {
  const views = buildServiceVariablesViews({
    runtimeAssignments: new Map([
      [
        'a',
        [
          {
            name: 'S',
            key: 'S',
            isSecret: true,
            value: 'leaked',
            source: 'project',
          },
        ],
      ],
      ['b', []],
    ]),
    buildAssignments: new Map(),
    secretPlan: [],
  })
  assertEquals(
    views.map((v) => v.composeServiceName),
    ['a']
  )
  assertEquals(views[0].variables[0].value, null)
})
