import { AcmeError } from '../../../lib/acme/client.ts'
import { TunnelProviderError } from '../../tunnels/errors.ts'
import { ChallengeTargetError } from './dns-provider.ts'

const MAX_MESSAGE = 300

function clip(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text
}

/** A failure in plain words, safe to store and show: no token, key or address of ours. */
export function plainFailure(err: unknown): string {
  if (err instanceof ChallengeTargetError) {
    return clip(
      `${err.name_} points to ${err.target}, and a validation record cannot sit beside it. ${err.message} Remove that CNAME, or give the token access to the zone that holds ${err.target}.`
    )
  }
  if (err instanceof AcmeError) {
    switch (err.code) {
      case 'rate_limited':
        return "Let's Encrypt asked us to wait before trying again. It will be tried again later."
      case 'caa':
        return "A CAA record on this domain does not allow Let's Encrypt to issue certificates."
      case 'dns':
        return clip(
          `Let's Encrypt could not find the validation record. Check that this domain's DNS is on the connected account and has no CNAME at _acme-challenge. ${err.message}`
        )
      case 'rejected_name':
        return clip(`Let's Encrypt does not issue certificates for this name. ${err.message}`)
      case 'unreachable':
        return clip(err.message)
      default:
        return clip(`Let's Encrypt refused the order. ${err.message}`)
    }
  }
  if (err instanceof TunnelProviderError) {
    if (err.code === 'forbidden' || err.code === 'unauthorized') {
      return 'The token cannot edit DNS records for this domain. Give it the DNS edit permission for the zone.'
    }
    return clip(err.message)
  }
  return 'Something went wrong while ordering the certificate. It will be tried again later.'
}
