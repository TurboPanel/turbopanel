/**
 * `describeStripeError` — the operator's log line for a Stripe refusal.
 */

import { assertEquals } from '@std/assert'
import { describeStripeError, StripeApiError } from './errors.ts'

const test = Deno.test.bind(Deno)

test('describeStripeError names every typed field and quotes Stripe’s message', () => {
  const err = new StripeApiError({
    status: 400,
    type: 'invalid_request_error',
    message: 'Stripe Tax has not been activated on your account.',
    code: 'stripe_tax_inactive',
    param: 'automatic_tax[enabled]',
    requestId: 'req_123',
  })
  assertEquals(
    describeStripeError(err),
    'status=400 type=invalid_request_error code=stripe_tax_inactive param=automatic_tax[enabled] ' +
      'request=req_123 message="Stripe Tax has not been activated on your account."'
  )
})

test('describeStripeError marks absent fields and redacts anything secret-shaped', () => {
  const err = new StripeApiError({
    status: 401,
    type: 'authentication_error',
    message: 'Invalid API Key provided: sk_test_abc123XYZ; webhook whsec_Q9zz and rk_live_77 too',
  })
  assertEquals(
    describeStripeError(err),
    'status=401 type=authentication_error code=- param=- request=- ' +
      'message="Invalid API Key provided: [redacted]; webhook [redacted] and [redacted] too"'
  )
})
