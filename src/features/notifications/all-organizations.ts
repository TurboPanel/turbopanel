/**
 * The `allOrganizations` field of a control plane notification channel body:
 * absent leaves the switch alone, a boolean sets it, anything else is refused.
 * Pure and import-free so Workers can bundle it.
 */
export type AllOrganizationsField =
  | { ok: true; value: boolean | undefined }
  | { ok: false; status: 400; error: 'all_organizations_invalid' }

export function parseAllOrganizationsField(raw: unknown): AllOrganizationsField {
  if (typeof raw !== 'object' || raw === null) return { ok: true, value: undefined }
  const value = (raw as Record<string, unknown>).allOrganizations
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value === 'boolean') return { ok: true, value }
  return { ok: false, status: 400, error: 'all_organizations_invalid' }
}

export const OPERATOR_WEBHOOK_HEARS_ALL_ORGANIZATIONS = {
  error: 'operator_webhook_hears_all_organizations',
  reason:
    'The operator alert webhook always hears every organization so it can page when a server goes dark. Remove it, or create another channel instead.',
} as const

/** The refusal for switching the operator webhook's switch off; null when the change is allowed. */
export function refuseOperatorWebhookOff(
  isOperatorWebhook: boolean,
  value: boolean | undefined
): typeof OPERATOR_WEBHOOK_HEARS_ALL_ORGANIZATIONS | null {
  return isOperatorWebhook && value === false ? OPERATOR_WEBHOOK_HEARS_ALL_ORGANIZATIONS : null
}
