import { assertEquals } from '@std/assert'
import {
  classifyDeployFailure,
  classifyPostDeployFailure,
  DEPLOY_CANCELLED_ERROR_CODE,
  deployOutcomeErrorCode,
  deployOutcomeReason,
  isCancelledDeployError,
  outcomeFromErrorCode,
} from './deploy-outcome.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

test('the daemon error prefix classifies a rolled back and a needs attention deploy', () => {
  assertEquals(
    classifyDeployFailure(
      'rolled_back: web failed its healthcheck; previous version is running again'
    ),
    {
      outcome: 'rolled_back',
      reason: 'web failed its healthcheck; previous version is running again',
    }
  )
  assertEquals(classifyDeployFailure('needs_attention: the pre-deploy step failed: boom'), {
    outcome: 'needs_attention',
    reason: 'the pre-deploy step failed: boom',
  })
})

test('anything else is an ordinary failure', () => {
  assertEquals(classifyDeployFailure('Docker Compose deployment failed'), null)
  assertEquals(classifyDeployFailure('the deploy rolled_back: no'), null)
  assertEquals(classifyDeployFailure(null), null)
  assertEquals(classifyDeployFailure('timed_out'), null)
})

test('error codes round trip and ignore unrelated codes', () => {
  assertEquals(deployOutcomeErrorCode('rolled_back'), 'deploy_rolled_back')
  assertEquals(outcomeFromErrorCode('deploy_rolled_back'), 'rolled_back')
  assertEquals(outcomeFromErrorCode('deploy_needs_attention'), 'needs_attention')
  assertEquals(outcomeFromErrorCode('deploy_other'), null)
  assertEquals(outcomeFromErrorCode('daemon_unsupported'), null)
  assertEquals(outcomeFromErrorCode(null), null)
})

test('the reason drops the prefix and is null without an outcome', () => {
  assertEquals(deployOutcomeReason('rolled_back', 'rolled_back: because'), 'because')
  assertEquals(deployOutcomeReason(null, 'rolled_back: because'), null)
  assertEquals(deployOutcomeReason('needs_attention', null), null)
})

test('a cancelled deploy is told apart by the daemon error prefix and is not a rollback', () => {
  const message = 'cancelled: stopped while building; the previous version is still running'
  assertEquals(isCancelledDeployError(message), true)
  assertEquals(isCancelledDeployError('Docker Compose build was cancelled'), false)
  assertEquals(isCancelledDeployError(null), false)
  assertEquals(isCancelledDeployError(undefined), false)
  assertEquals(DEPLOY_CANCELLED_ERROR_CODE, 'deploy_cancelled')
  // Neither a strategy outcome nor a rollback: history reads it from `status`.
  assertEquals(classifyDeployFailure(message), null)
  assertEquals(outcomeFromErrorCode(DEPLOY_CANCELLED_ERROR_CODE), null)
})

const AFTER_SWITCH =
  'post_deploy_failed_after_switch: Post-deploy commands for site web failed after the new release rel-2 went live. /usr/bin/php exited with exit status 1. Roll back to the previous release rel-1 from the deploy page if the site is not working.'

test('a post-deploy failure after the switch names the program and offers Roll Back', () => {
  const failure = classifyPostDeployFailure(AFTER_SWITCH)
  assertEquals(failure?.program, '/usr/bin/php')
  assertEquals(failure?.how, 'exited with exit status 1')
  assertEquals(failure?.failedReleaseId, 'rel-2')
  assertEquals(failure?.previousReleaseId, 'rel-1')
  assertEquals(failure?.rollBackAvailable, true)
  assertEquals(
    failure?.message,
    'The post-deploy command /usr/bin/php exited with exit status 1 after the new release went live. The previous release is still available: roll back to it if the site is not working.'
  )
  const timedOut = classifyPostDeployFailure(
    AFTER_SWITCH.replace('exited with exit status 1', 'timed out')
  )
  assertEquals(
    timedOut?.message.startsWith('The post-deploy command /usr/bin/php timed out after'),
    true
  )
})

test('a post-deploy failure without a program or a previous release still reads clearly', () => {
  const failure = classifyPostDeployFailure(
    'post_deploy_failed_after_switch: Post-deploy commands for site web failed after the new release rel-2 went live. Roll back to the previous release from the deploy page if the site is not working.'
  )
  assertEquals(failure?.program, null)
  assertEquals(failure?.rollBackAvailable, false)
  assertEquals(failure?.message, 'A post-deploy command failed after the new release went live.')
})

test('an unknown or older error text is not a post-deploy failure', () => {
  assertEquals(classifyPostDeployFailure('Docker Compose deployment failed'), null)
  assertEquals(
    classifyPostDeployFailure('Post-deploy commands for site web failed after the new release went live.'),
    null
  )
  assertEquals(classifyPostDeployFailure(null), null)
})
