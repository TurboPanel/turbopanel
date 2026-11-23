# Stripe API 2026-11-18.endive

Checked 2026-11-23. Pin moved from `2026-09-30.endive` to `2026-11-18.endive`.

## Sources

- https://docs.stripe.com/changelog (release list)
- https://docs.stripe.com/changelog/endive (per-release tables, with a "Breaking change?" column)
- https://docs.stripe.com/upgrades (upgrade guidance)

## Is it real

Yes. The Endive page lists three GA releases: `2026-09-30.endive`,
`2026-10-28.endive` and `2026-11-18.endive`. Stripe states that the first
Endive version carried the breaking changes and that later Endive versions are
additive only.

## Breaking changes between 2026-09-30.endive and 2026-11-18.endive

None. Every entry under `2026-10-28.endive` and `2026-11-18.endive` is marked
Non-breaking. The "Breaking" rows in that window (microdeposit arrival dates
nullable; Financial Addresses v2, Received Credits v2, Payout Methods v2,
outbound payments, Financial Account create parameters) all sit under the
`2026-10-28.preview` and `2026-11-18.preview` headings, which are the preview
channel and do not apply to a `.endive` pin.

## Non-breaking entries near the code we use

- Billing portal: subscription pausing, session recovery for expired portal
  sessions (2026-10-28); lost benefits in product marketing features
  (2026-11-18). All opt-in.
- Subscriptions: new error code for billing cycle anchor and trial validation
  (2026-10-28). Adds a new `error.code` value only; our Stripe error handling
  keys on HTTP status and the existing code mapping, not an exhaustive list.
- Checkout sessions: payment intent data when updating sessions, invoice
  settings parameters for subscription mode (2026-10-28). Opt-in parameters.
- Tax: new registration types, tax ID types and tax types (2026-10-28), IGIC
  registrations and address collection precision (2026-11-18). Additive enum
  values.
- Webhook events: semantic thin events for subscriptions and invoicing
  (2026-10-28). Opt-in subscriptions; snapshot event payloads we parse are
  unchanged.
- Customers, subscription schedules, test clocks: no entries.
- Accounts v2 (`/v2/core/accounts`, relevant to PR #1038): only additive
  capability and parameter entries (Pix, PayPay, Billie, MB WAY, NZ BECS,
  Konbini additional material, Express accounts with Stripe pricing, dashboard
  access on Account Links v2, alternative requirements). Nothing breaking.

## Endpoints in use (grep of src/features/billing and src/webhook/billing)

checkout/sessions, subscriptions, subscription_items, subscription_schedules,
billing_portal/configurations and sessions, customers, invoices and
invoices/create_preview, products, prices, tax/settings, test_helpers/test_clocks.
None appears in a breaking entry for this window.

## What changed in this PR

- `DEFAULT_STRIPE_API_VERSION` in `src/features/billing/config.ts`.
- Test fixtures that meant "the pinned version" now import the constant.
- Comments and `src/features/billing/AGENTS.md` that named the version.
- Fixtures that use other versions on purpose are untouched.

No code needed fixing. The "verified on `2025-08-27.basil`, not yet
re-verified" notes remain accurate: this change reads the changelog; it does
not exercise a live Stripe account.

## Follow-up for the owner

Webhook endpoint API versions are set in the Stripe dashboard. Move them to
`2026-11-18.endive` to match the pin.
