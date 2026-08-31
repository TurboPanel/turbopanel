import { assertEquals } from '@std/assert'
import {
  classifyDeployKey,
  classifyDeployPlacementKey,
  classifyNetworkKey,
  classifyServiceKey,
  classifyTopLevelKey,
  DEPLOY_FIELD_KEYS,
  DEPLOY_KEYS_STRIPPED_FROM_RUNTIME,
  NETWORK_FIELD_KEYS,
  SPANNING_NETWORK_DRIVER,
  unsupportedDeployReason,
  unsupportedNetworkReason,
} from './field-policy.ts'
import { blockingComposeLintIssues, lintComposeYaml } from './lint.ts'
import { validateComposeForDeploy } from './validate-for-deploy.ts'
import { yamlToComposeDocument } from './convert.ts'
import { FIELD_POLICY_FIXTURES } from './field-policy.fixtures.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('every unsupported field carries a reason the diagnostic can quote', () => {
  for (const key of DEPLOY_FIELD_KEYS) {
    const policy = classifyDeployKey(key)
    if (policy?.state !== 'unsupported') continue
    // A bare "unsupported" tells an operator nothing they can act on.
    assertEquals(typeof unsupportedDeployReason(key), 'string')
    assertEquals((unsupportedDeployReason(key) ?? '').length > 20, true)
  }
})

test('an unsupported deploy key never reaches runtime YAML either', () => {
  for (const key of DEPLOY_FIELD_KEYS) {
    if (classifyDeployKey(key)?.state !== 'unsupported') continue
    assertEquals(DEPLOY_KEYS_STRIPPED_FROM_RUNTIME.has(key), true)
  }
})

test('the runtime strip set is exactly the scheduler and unsupported keys', () => {
  assertEquals(
    [...DEPLOY_KEYS_STRIPPED_FROM_RUNTIME].sort(),
    [
      'endpoint_mode',
      'mode',
      'placement',
      'replicas',
      'rollback_config',
      'update_config',
    ],
  )
})

test('deploy.resources stays passthrough — Docker standalone honours it', () => {
  assertEquals(classifyDeployKey('resources')?.state, 'passthrough')
  assertEquals(DEPLOY_KEYS_STRIPPED_FROM_RUNTIME.has('resources'), false)
})

test('deploy.restart_policy and deploy.labels are read and still forwarded', () => {
  assertEquals(classifyDeployKey('restart_policy')?.state, 'interpreted')
  assertEquals(classifyDeployKey('labels')?.state, 'interpreted')
  assertEquals(DEPLOY_KEYS_STRIPPED_FROM_RUNTIME.has('restart_policy'), false)
  assertEquals(DEPLOY_KEYS_STRIPPED_FROM_RUNTIME.has('labels'), false)
})

test('placement.max_replicas_per_node is not refused by this phase', () => {
  // It belongs to the scheduler work; flagging it here would refuse documents
  // the very next phase honours.
  assertEquals(
    classifyDeployPlacementKey('max_replicas_per_node')?.state,
    'interpreted',
  )
})

test('deploy.placement.server_id is recorded as runtime-generated', () => {
  assertEquals(classifyDeployPlacementKey('server_id')?.state, 'runtime-generated')
})

test('driver: overlay is the one network key TurboPanel acts on', () => {
  assertEquals(SPANNING_NETWORK_DRIVER, 'overlay')
  assertEquals(classifyNetworkKey('driver')?.state, 'interpreted')
  assertEquals(classifyNetworkKey('driver', 'overlay')?.state, 'interpreted')
  assertEquals(classifyNetworkKey('nope'), undefined)
})

test('a non-overlay network keeps every attribute passthrough', () => {
  // A bridge network's ipam/attachable/driver_opts/internal go straight to
  // Docker exactly as before; refusing them here would break documents that
  // work.
  for (const key of ['attachable', 'ipam', 'driver_opts', 'enable_ipv6', 'internal']) {
    assertEquals(classifyNetworkKey(key)?.state, 'passthrough')
    assertEquals(classifyNetworkKey(key, 'bridge')?.state, 'passthrough')
    assertEquals(unsupportedNetworkReason(key, 'bridge'), undefined)
  }
})

test('an overlay network refuses the five attributes TurboFabric substitutes', () => {
  for (const key of ['attachable', 'ipam', 'driver_opts', 'enable_ipv6', 'internal']) {
    assertEquals(classifyNetworkKey(key, 'overlay')?.state, 'unsupported')
    // A bare "unsupported" tells an operator nothing they can act on.
    assertEquals((unsupportedNetworkReason(key, 'overlay') ?? '').length > 20, true)
  }
  // external/name still name the operator's own registered Docker network, and
  // such an entry never becomes a tpn_* one at all.
  assertEquals(classifyNetworkKey('external', 'overlay')?.state, 'passthrough')
  assertEquals(classifyNetworkKey('name', 'overlay')?.state, 'passthrough')
  assertEquals(classifyNetworkKey('labels', 'overlay')?.state, 'passthrough')
})

test('every network key the registry knows has an answer at both drivers', () => {
  for (const key of NETWORK_FIELD_KEYS) {
    assertEquals(typeof classifyNetworkKey(key)?.state, 'string')
    assertEquals(typeof classifyNetworkKey(key, 'overlay')?.state, 'string')
  }
})

test('the registry answers for top-level and service keys', () => {
  assertEquals(classifyTopLevelKey('services')?.state, 'passthrough')
  assertEquals(classifyTopLevelKey('version')?.state, 'interpreted')
  assertEquals(classifyTopLevelKey('nope'), undefined)
  // `include` and `models` are real Compose keys this control plane does not
  // implement; they stay unknown rather than becoming accepted no-ops.
  assertEquals(classifyTopLevelKey('include'), undefined)
  assertEquals(classifyServiceKey('image')?.state, 'passthrough')
  assertEquals(classifyServiceKey('deploy')?.state, 'interpreted')
  assertEquals(classifyServiceKey('imaage'), undefined)
})

for (const fixture of FIELD_POLICY_FIXTURES) {
  test(`fixture (permissive): ${fixture.description}`, () => {
    const issues = lintComposeYaml(fixture.compose)
    const blocking = blockingComposeLintIssues(issues)
    for (const expected of fixture.expectedIssues) {
      const found = issues.find((issue) => issue.path === expected.path)
      assertEquals(found?.level, expected.level, `level for ${expected.path}`)
      assertEquals(
        found?.message.includes(expected.messageIncludes),
        true,
        `message for ${expected.path}: ${found?.message}`,
      )
      assertEquals(
        blocking.some((issue) => issue.path === expected.path),
        expected.blocking,
        `blocking for ${expected.path}`,
      )
    }
    // Nothing beyond what the fixture declares — an extra diagnostic is drift
    // between the two linters just as surely as a missing one.
    assertEquals(
      issues.map((issue) => issue.path).sort(),
      fixture.expectedIssues.map((issue) => issue.path).sort(),
    )
  })

  test(`fixture (strict): ${fixture.description}`, () => {
    const issues = lintComposeYaml(fixture.compose, { strict: true })
    for (const expected of fixture.expectedIssues) {
      const found = issues.find((issue) => issue.path === expected.path)
      assertEquals(
        found?.level,
        expected.strictLevel ?? expected.level,
        `strict level for ${expected.path}`,
      )
      if (expected.strictLevel) {
        // Strictness is what makes it a refusal; permissiveness kept it advice.
        assertEquals(found?.blocking, undefined)
        assertEquals(found?.code, 'field_unsupported')
      }
    }
  })

  test(`fixture (deploy gate): ${fixture.description}`, () => {
    const error = validateComposeForDeploy(
      yamlToComposeDocument(fixture.compose),
    )
    // A fixture whose findings already block at save time never reaches the
    // policy stage: the merged document fails stages 1-3 first, and the deploy
    // is refused as `compose_merged_invalid`. Ordering is the point — the
    // policy verdict on a document that is not a valid Compose file would be
    // an answer to the wrong question.
    const blocksBeforePolicy = fixture.expectedIssues.some(
      (issue) => issue.blocking && issue.strictLevel === undefined,
    )
    if (blocksBeforePolicy) {
      assertEquals(error?.kind, 'compose_merged_invalid')
      return
    }
    const expectedPaths = fixture.expectedIssues
      .filter((issue) => issue.strictLevel === 'error')
      .map((issue) => issue.path)
      .sort()
    assertEquals(
      error?.kind,
      expectedPaths.length === 0 ? undefined : 'compose_field_unsupported',
    )
    assertEquals(
      (error?.issues ?? []).map((issue) => issue.path).sort(),
      expectedPaths,
    )
  })
}
