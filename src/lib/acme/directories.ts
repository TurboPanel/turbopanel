/** The two certificate-authority directories this panel talks to. */
export const ACME_PRODUCTION_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory'
export const ACME_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory'

/** Staging certificates are not trusted by browsers; they are for tests only. */
export function acmeDirectoryUrl(staging: boolean): string {
  return staging ? ACME_STAGING_DIRECTORY : ACME_PRODUCTION_DIRECTORY
}
