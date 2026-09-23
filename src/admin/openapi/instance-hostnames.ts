import { ADMIN_API_PREFIX } from "../../app/surfaces.ts";

const cookieSecurity = [{ cookieAuth: [] }] as const;

/**
 * Control-plane hostname, uploaded-certificate, and instance ACME paths.
 * Shared by Deno and Workers — these routes are mounted on both runtimes.
 */
export const INSTANCE_HOSTNAME_PATHS = {
  [`${ADMIN_API_PREFIX}/instance/hostnames`]: {
    get: {
      tags: ["Instance"],
      summary: "List control-plane hostnames",
      description:
        "Each entry is a published name with its certificate source " +
        "(`platform-ca`, `uploaded`, or `lets-encrypt`), derived status, and expiry.",
      security: [...cookieSecurity],
      responses: {
        "200": { description: "`{ ok, hostnames }`" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
      },
    },
    put: {
      tags: ["Instance"],
      summary: "Replace the control-plane hostname set",
      description:
        "Body `{ hostnames: [{ host, source, uploadedCertId? }] }`. " +
        "Let's Encrypt is refused for loopback, private, and wildcard names. " +
        "An `uploaded` source must name a stored pair whose names cover the host.",
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        "200": { description: "`{ ok, hostnames }`" },
        "400": { description: "Invalid request body" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
        "422": {
          description:
            "`{ ok: false, error, invalid }` when a hostname fails validation",
        },
        "503": { description: "Database unavailable" },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/certificates`]: {
    get: {
      tags: ["Instance"],
      summary: "List uploaded control-plane certificates",
      description:
        "Label, parsed names, expiry, and the hostnames attached to each pair. " +
        "The private key is never returned.",
      security: [...cookieSecurity],
      responses: {
        "200": { description: "`{ ok, certificates }`" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
      },
    },
    post: {
      tags: ["Instance"],
      summary: "Upload a control-plane certificate pair",
      description:
        "Body `{ label, certPem, keyPem }`. The leaf is parsed and the key must " +
        "match. The key is sealed at rest.",
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        "201": {
          description:
            "`{ ok, id, label, dnsNames, hasWildcard, notAfter, fingerprintSha256 }`",
        },
        "400": { description: "Invalid request body" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
        "422": { description: "Certificate parse or key match failed" },
        "503": { description: "Database or encryption unavailable" },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/certificates/{id}/hostnames`]: {
    patch: {
      tags: ["Instance"],
      summary: "Attach or detach hostnames for an uploaded certificate",
      description:
        "Body `{ hosts: string[] }` is the full attachment set. Every host must " +
        "be covered by the pair. Names dropped from the set stay published as " +
        "`platform-ca`.",
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        "200": { description: "`{ ok, hostnames }`" },
        "400": { description: "Invalid request body" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
        "404": { description: "Certificate not found" },
        "422": {
          description:
            "A hostname is invalid or not covered by the certificate",
        },
        "503": { description: "Database unavailable" },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/acme`]: {
    get: {
      tags: ["Instance"],
      summary: "Read instance ACME settings",
      description:
        "Instance-wide Let's Encrypt contact, terms acceptance, directory URL, " +
        "and staging flag. Independent of any organization's ACME opt-in.",
      security: [...cookieSecurity],
      responses: {
        "200": {
          description: "`{ settings }` keyed by `TURBOPANEL_INSTANCE_ACME__*`",
        },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
        "503": { description: "Database unavailable" },
      },
    },
    put: {
      tags: ["Instance"],
      summary: "Update instance ACME settings",
      description:
        "Partial object of setting keys. Env values win and are not overwritten. " +
        "Returns 503 when an update would seal a secret and no encryption key is configured.",
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        "200": { description: "`{ settings }`" },
        "400": { description: "Invalid request body" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
        "422": { description: "A setting value is invalid" },
        "503": {
          description:
            "Database unavailable, or encryption is required and missing",
        },
      },
    },
  },
};
