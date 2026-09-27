/**
 * The invitation link secret. The invitation's primary key is **not** a
 * secret — `GET /invitations` shows it to organization managers, `POST
 * /invitations` returns it to the inviter, and it is a time-ordered UUIDv7 —
 * so nothing that must prove control of the invited email may key on it.
 *
 * Each invitation gets 256 random bits emailed only in the accept link
 * (`/accept-invitation?token=`). The row stores only a purpose-bound SHA-256
 * verifier (`invitation.token_hash`, unique), never the token, and no API
 * returns either. The landing page looks the invitation up by verifier, and
 * only that path treats the click as proof of the address. Re-sending an
 * invitation mints a new token, so the previous link stops working.
 */
import { deriveLinkTokenVerifier, generateLinkToken } from '../authn/link-token.ts'

/** Domain separation for {@link deriveLinkTokenVerifier}; bump to void every link. */
export const INVITATION_TOKEN_CONTEXT = 'invitation-link:v1'

/** Link tokens are 64 lowercase hex characters (`link-token.ts`). */
const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/

export function isInvitationToken(value: string): boolean {
  return INVITATION_TOKEN_PATTERN.test(value)
}

export async function invitationTokenHash(token: string): Promise<string> {
  return await deriveLinkTokenVerifier(INVITATION_TOKEN_CONTEXT, token)
}

/** A fresh token and the verifier to store for it. */
export async function mintInvitationToken(): Promise<{ token: string; tokenHash: string }> {
  const token = generateLinkToken()
  return { token, tokenHash: await invitationTokenHash(token) }
}

/** The console page the emailed link opens. */
export function invitationAcceptUrl(baseOrigin: string, token: string): string {
  return `${baseOrigin.replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(token)}`
}
