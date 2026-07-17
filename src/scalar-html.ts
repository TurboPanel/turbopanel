import { resolveSessionCookieNameFromUrl } from './client/authn/crypto.ts'

/** Self-contained Scalar CDN embed HTML for GET /api/client/v1/reference. */
export function buildClientScalarHtml(specUrl: string, requestOrigin: string): string {
  const sessionCookieName = resolveSessionCookieNameFromUrl(requestOrigin)
  const configuration = JSON.stringify({
    theme: 'purple',
    layout: 'modern',
    pageTitle: 'TurboPanel API Reference',
    authentication: {
      preferredSecurityScheme: 'cookieAuth',
      createAnySecurityScheme: false,
      securitySchemes: {
        cookieAuth: { name: sessionCookieName },
      },
    },
    persistAuth: true,
  })

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TurboPanel API Reference</title>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script>
    document.getElementById('api-reference').dataset.configuration = ${configuration};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`
}

/** Self-contained Scalar CDN embed HTML for GET /api/daemon/v1/reference. */
export function buildDaemonScalarHtml(specUrl: string): string {
  const configuration = JSON.stringify({
    theme: 'purple',
    layout: 'modern',
    pageTitle: 'TurboPanel Daemon API Reference',
    authentication: {
      preferredSecurityScheme: 'bearerAuth',
      createAnySecurityScheme: false,
      securitySchemes: {
        bearerAuth: {
          token: '',
        },
      },
    },
    persistAuth: true,
  })

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TurboPanel Daemon API Reference</title>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script>
    document.getElementById('api-reference').dataset.configuration = ${configuration};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`
}

/** Self-contained Scalar CDN embed HTML for GET /api/admin/v1/reference. */
export function buildAdminScalarHtml(specUrl: string, requestOrigin: string): string {
  const sessionCookieName = resolveSessionCookieNameFromUrl(requestOrigin)
  const configuration = JSON.stringify({
    theme: 'purple',
    layout: 'modern',
    pageTitle: 'TurboPanel Admin API Reference',
    authentication: {
      preferredSecurityScheme: 'cookieAuth',
      createAnySecurityScheme: false,
      securitySchemes: {
        cookieAuth: { name: sessionCookieName },
      },
    },
    persistAuth: true,
  })

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TurboPanel Admin API Reference</title>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script>
    document.getElementById('api-reference').dataset.configuration = ${configuration};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`
}
