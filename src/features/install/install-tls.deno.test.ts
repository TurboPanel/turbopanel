import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../../app/app.ts";
import { DAEMON_API_PREFIX } from "../../app/surfaces.ts";
import { registerDaemonApiRoutes } from "../../daemon/api-routes.ts";
import type { Db } from "../../db/connection.ts";
import {
  instanceHostname,
  instanceUploadedCertificate,
} from "../../db/schema.ts";
import { buildLicenseInstallCommand } from "./daemon-install-command.ts";
import {
  privateUploadedTrustUnavailable,
  readPlatformCaLeafNames,
  resolveInstallOriginTls,
  uploadedCertificateChainsToPublicRoot,
} from "./install-trust.ts";
import {
  dialedInstallHostname,
  formatInstanceDlBase,
  hostnamePresentsPlatformCaLeaf,
  type InstallHostnameTrust,
  type InstallOriginCertificateSource,
  installOriginNeedsInsecureTls,
  installOriginTlsOptions,
  resolvePublicInstanceTls,
  shouldServePlatformCaBundle,
  UNLISTED_INSTALL_HOSTNAME_UNCOVERED,
  unlistedSelfHostedInstallRefusal,
} from "./install-tls.ts";
import {
  issueLeafCertificate,
  mintOrganizationCa,
  verifyCertificateSignature,
} from "../../lib/tls/self-signed.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("installOriginNeedsInsecureTls trusts public HTTPS on 443", () => {
  assertEquals(installOriginNeedsInsecureTls("https://turbopanel.dev"), false);
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com"),
    false,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com:443"),
    false,
  );
  assertEquals(installOriginNeedsInsecureTls("https://203.0.113.50"), false);
  assertEquals(
    installOriginNeedsInsecureTls("  https://turbopanel.dev  "),
    false,
  );
});

test("installOriginNeedsInsecureTls flags private names on any port", () => {
  assertEquals(installOriginNeedsInsecureTls("https://studio.lan:8443"), true);
  assertEquals(installOriginNeedsInsecureTls("https://huey.lan:8443"), true);
  assertEquals(installOriginNeedsInsecureTls("https://studio.lan"), true);
  assertEquals(installOriginNeedsInsecureTls("https://box.local"), true);
  assertEquals(installOriginNeedsInsecureTls("https://localhost"), true);
  assertEquals(
    installOriginNeedsInsecureTls("https://192.168.1.10:8443"),
    true,
  );
  assertEquals(installOriginNeedsInsecureTls("https://10.0.0.5"), true);
});

test("installOriginNeedsInsecureTls flags reserved LAN TLDs on 443", () => {
  assertEquals(installOriginNeedsInsecureTls("https://app.internal"), true);
  assertEquals(installOriginNeedsInsecureTls("https://nas.home"), true);
  assertEquals(installOriginNeedsInsecureTls("https://git.corp"), true);
  assertEquals(installOriginNeedsInsecureTls("https://dev.localhost"), true);
});

test("installOriginNeedsInsecureTls flags loopback and private IPv4", () => {
  assertEquals(installOriginNeedsInsecureTls("https://127.0.0.1"), true);
  assertEquals(installOriginNeedsInsecureTls("https://192.168.1.10"), true);
  assertEquals(installOriginNeedsInsecureTls("https://172.16.0.1"), true);
  assertEquals(installOriginNeedsInsecureTls("https://172.31.255.1"), true);
  assertEquals(installOriginNeedsInsecureTls("https://169.254.1.1"), true);
  // 172.15 / 172.32 are not RFC1918 — treat as public on 443.
  assertEquals(installOriginNeedsInsecureTls("https://172.15.0.1"), false);
  assertEquals(installOriginNeedsInsecureTls("https://172.32.0.1"), false);
});

test("installOriginNeedsInsecureTls ignores non-IPv4 dotted hosts", () => {
  // Four dotted labels that are not octets fall through to the TLD check.
  assertEquals(installOriginNeedsInsecureTls("https://a.b.c.com"), false);
  assertEquals(installOriginNeedsInsecureTls("https://192.168.1.999"), false);
  assertEquals(installOriginNeedsInsecureTls("https://192.168.1.x"), false);
});

test("installOriginNeedsInsecureTls flags loopback and private IPv6", () => {
  assertEquals(installOriginNeedsInsecureTls("https://[::1]"), true);
  assertEquals(
    installOriginNeedsInsecureTls("https://[0:0:0:0:0:0:0:1]"),
    true,
  );
  assertEquals(installOriginNeedsInsecureTls("https://[fe80::1]"), true);
  assertEquals(installOriginNeedsInsecureTls("https://[fc00::1]"), true);
  assertEquals(installOriginNeedsInsecureTls("https://[fd12:3456::1]"), true);
  // Public IPv6 on 443 stays system-trust.
  assertEquals(installOriginNeedsInsecureTls("https://[2001:db8::1]"), false);
});

test("installOriginNeedsInsecureTls ignores the port when no source is known", () => {
  assertEquals(
    installOriginNeedsInsecureTls("https://turbopanel.dev:8443"),
    false,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://203.0.113.50:9443"),
    false,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://[2001:db8::1]:8443"),
    false,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com:8443"),
    false,
  );
});

test("installOriginNeedsInsecureTls follows the hostname certificate source", () => {
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com:8443", {
      source: "platform-ca",
    }),
    true,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com:8443", {
      source: "lets-encrypt",
    }),
    false,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com:8443", {
      source: "uploaded",
    }),
    true,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com:8443", {
      source: "uploaded",
      publicUploaded: true,
    }),
    false,
  );
  assertEquals(
    installOriginNeedsInsecureTls("https://studio.lan:8443", {
      source: "platform-ca",
      publicUploaded: true,
    }),
    true,
  );
});

test("installOriginNeedsInsecureTls never flags plaintext HTTP", () => {
  assertEquals(installOriginNeedsInsecureTls("http://studio.lan"), false);
  assertEquals(installOriginNeedsInsecureTls("http://turbopanel.dev"), false);
  assertEquals(installOriginNeedsInsecureTls("ftp://studio.lan"), false);
  assertEquals(installOriginNeedsInsecureTls(""), false);
  assertEquals(installOriginNeedsInsecureTls("not a url"), false);
});

test("installOriginTlsOptions marks only an uploaded leaf from TURBOPANEL_TLS_PUBLIC", () => {
  const env = { TURBOPANEL_TLS_PUBLIC: "1" };
  assertEquals(installOriginTlsOptions("uploaded", env), {
    source: "uploaded",
    publicUploaded: true,
  });
  assertEquals(installOriginTlsOptions("platform-ca", env), {
    source: "platform-ca",
  });
  assertEquals(installOriginTlsOptions("lets-encrypt", {}), {
    source: "lets-encrypt",
  });
  assertEquals(installOriginTlsOptions(undefined, env), {});
  assertEquals(
    installOriginNeedsInsecureTls(
      "https://panel.example.com:8443",
      installOriginTlsOptions("platform-ca", env),
    ),
    true,
  );
  assertEquals(
    installOriginNeedsInsecureTls(
      "https://panel.example.com:8443",
      installOriginTlsOptions("uploaded", env),
    ),
    false,
  );
});

test("installOriginNeedsInsecureTls still flags private origins without publicOrigin", () => {
  assertEquals(installOriginNeedsInsecureTls("https://studio.lan:8443"), true);
  assertEquals(installOriginNeedsInsecureTls("https://box.local"), true);
  assertEquals(installOriginNeedsInsecureTls("https://localhost"), true);
  assertEquals(
    installOriginNeedsInsecureTls("https://192.168.1.10:8443"),
    true,
  );
  assertEquals(installOriginNeedsInsecureTls("https://10.0.0.5"), true);
});

test("resolvePublicInstanceTls accepts 1 and true", () => {
  assertEquals(resolvePublicInstanceTls({ TURBOPANEL_TLS_PUBLIC: "1" }), true);
  assertEquals(
    resolvePublicInstanceTls({ TURBOPANEL_TLS_PUBLIC: "true" }),
    true,
  );
  assertEquals(
    resolvePublicInstanceTls({ TURBOPANEL_TLS_PUBLIC: "TRUE" }),
    true,
  );
  assertEquals(
    resolvePublicInstanceTls({ TURBOPANEL_TLS_PUBLIC: " True " }),
    true,
  );
});

test("resolvePublicInstanceTls rejects empty and 0", () => {
  assertEquals(resolvePublicInstanceTls({}), false);
  assertEquals(resolvePublicInstanceTls({ TURBOPANEL_TLS_PUBLIC: "" }), false);
  assertEquals(resolvePublicInstanceTls({ TURBOPANEL_TLS_PUBLIC: "0" }), false);
  assertEquals(
    resolvePublicInstanceTls({ TURBOPANEL_TLS_PUBLIC: "false" }),
    false,
  );
});

test("installOriginNeedsInsecureTls returns false for unparseable HTTPS origins", () => {
  assertEquals(installOriginNeedsInsecureTls("https://"), false);
  assertEquals(installOriginNeedsInsecureTls("https://["), false);
});

test("a Let's Encrypt sibling does not mark a private uploaded leaf as public", () => {
  const env = {
    TURBOPANEL_TLS_PUBLIC: "1",
    TURBOPANEL_TLS_UPLOADED_PUBLIC: "1",
  };
  const hostnames = [
    { host: "https://acme.example.com:8443", source: "lets-encrypt" as const },
    {
      host: "https://private.example.com:8443",
      source: "uploaded" as const,
      publicUploaded: false,
    },
  ];
  const options = installOriginTlsOptions("uploaded", env, {
    hostnames,
    origin: "https://private.example.com:8443",
  });
  assertEquals(options, { source: "uploaded", publicUploaded: false });
  assertEquals(
    installOriginNeedsInsecureTls("https://private.example.com:8443", options),
    true,
  );
  assertEquals(
    installOriginTlsOptions("uploaded", env, { hostnames }).publicUploaded,
    false,
  );
});

function installCommandFor(
  origin: string,
  source: InstallOriginCertificateSource | undefined,
  hostnames: readonly InstallHostnameTrust[],
  env: Record<string, string | undefined>,
): string {
  return buildLicenseInstallCommand({
    runtime: "deno",
    instanceUrl: origin,
    licenseId: "lic",
    licenseToken: "tok",
    insecureTls: installOriginNeedsInsecureTls(
      origin,
      installOriginTlsOptions(source, env, {
        hostnames,
        origin,
        selfHostedListener: true,
      }),
    ),
  });
}

function bootstrapsInsecure(command: string): boolean {
  return command.includes("curl -fsSLk") &&
    command.includes("TURBOPANEL_INSECURE_TLS=1");
}

test("install commands choose -k independently for each uploaded hostname", () => {
  const env = {
    TURBOPANEL_TLS_PUBLIC: "1",
    TURBOPANEL_TLS_UPLOADED_PUBLIC: "1",
  };
  const hostnames: InstallHostnameTrust[] = [
    { host: "https://acme.example.com:8443", source: "lets-encrypt" },
    {
      host: "https://public.example.com:8443",
      source: "uploaded",
      publicUploaded: true,
    },
    {
      host: "https://private.example.com:8443",
      source: "uploaded",
      publicUploaded: false,
    },
  ];
  const acme = installCommandFor(
    "https://acme.example.com:8443",
    "lets-encrypt",
    hostnames,
    env,
  );
  const published = installCommandFor(
    "https://public.example.com:8443",
    "uploaded",
    hostnames,
    env,
  );
  const privateLeaf = installCommandFor(
    "https://private.example.com:8443",
    "uploaded",
    hostnames,
    env,
  );
  assertEquals(bootstrapsInsecure(acme), false);
  assertEquals(acme.includes("curl -fsSLk"), false);
  assertEquals(bootstrapsInsecure(published), false);
  assertEquals(published.includes("curl -fsSLk"), false);
  assertEquals(bootstrapsInsecure(privateLeaf), true);
  assertEquals(privateLeaf.includes("TURBOPANEL_INSECURE_TLS=1"), true);
});

test("an unlisted public name on the self-hosted :8443 listener needs Platform CA bootstrap trust", () => {
  const origin = "https://panel.example.com:8443";
  const listener = installOriginTlsOptions(undefined, {}, {
    hostnames: [],
    selfHostedListener: true,
  });
  assertEquals(installOriginNeedsInsecureTls(origin, listener), true);
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com:443", listener),
    false,
  );
  assertEquals(
    installOriginNeedsInsecureTls(
      origin,
      installOriginTlsOptions(undefined, {}, { selfHostedListener: false }),
    ),
    false,
  );
});

test("GET /instance/ca still serves the Platform CA when a hostname presents that leaf", async () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const app = new Hono();
  registerDaemonApiRoutes(app, {
    tlsPublic: true,
    platformCaLeafPresented: () => Promise.resolve(true),
    readPlatformCaPem: () => Promise.resolve(pem),
  });
  const served = await app.request(`${DAEMON_API_PREFIX}/instance/ca`);
  assertEquals(served.status, 200);
  assertEquals(await served.text(), pem);
  assertEquals(served.headers.get("content-type"), "application/x-pem-file");

  const hidden = new Hono();
  registerDaemonApiRoutes(hidden, {
    tlsPublic: true,
    platformCaLeafPresented: () => Promise.resolve(false),
    readPlatformCaPem: () => Promise.resolve(pem),
  });
  const missing = await hidden.request(`${DAEMON_API_PREFIX}/instance/ca`);
  assertEquals(missing.status, 404);
  assertEquals(await missing.json(), { error: "platform CA not configured" });

  const env = { TURBOPANEL_TLS_PUBLIC: "1" };
  const hostnames = [
    { source: "lets-encrypt" as const },
    { source: "platform-ca" as const },
  ];
  assertEquals(
    installOriginNeedsInsecureTls(
      "https://panel.example.com:8443",
      installOriginTlsOptions("platform-ca", env, { hostnames }),
    ),
    true,
  );
  assertEquals(shouldServePlatformCaBundle(true, true), true);
  assertEquals(shouldServePlatformCaBundle(true, false), false);
  assertEquals(shouldServePlatformCaBundle(false, false), true);
});

test("formatInstanceDlBase strips a trailing slash on the origin", () => {
  assertEquals(
    formatInstanceDlBase("https://turbopanel.dev/"),
    "https://turbopanel.dev/downloads/daemon",
  );
  assertEquals(
    formatInstanceDlBase("https://turbopanel.dev"),
    "https://turbopanel.dev/downloads/daemon",
  );
});

function hostnameRow(
  host: string,
  source: InstallOriginCertificateSource,
  uploadedCertId: string | null,
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    host,
    source,
    uploadedCertId,
    acmeLastAttemptAt: null,
    acmeLastError: null,
    notAfter: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function memoryInstallDb(
  hostnames: Record<string, unknown>[],
  certificates: Record<string, unknown>[],
): Db {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === instanceHostname) return Promise.resolve(hostnames);
              if (table === instanceUploadedCertificate) {
                return Promise.resolve(certificates);
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

test("an unlisted public name on a Let's Encrypt-only listener keeps the Platform CA trust anchor", async () => {
  const ca = await mintOrganizationCa({ organizationId: "install-tls" });
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ["panel.example.com"],
  );
  const privateLeaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ["private.example.com"],
  );
  const origin = "https://panel.example.com:8443";
  const stored = [
    { host: "https://acme.example.com:8443", source: "lets-encrypt" as const },
  ];
  assertEquals(
    hostnamePresentsPlatformCaLeaf("panel.example.com", stored),
    true,
  );
  assertEquals(
    hostnamePresentsPlatformCaLeaf("acme.example.com:8443", stored),
    false,
  );
  assertEquals(
    hostnamePresentsPlatformCaLeaf("private.example.com", [
      {
        host: "https://private.example.com:8443",
        source: "uploaded",
      },
    ]),
    false,
  );
  assertEquals(
    dialedInstallHostname(
      "panel.example.com:8443",
      "http://localhost/api/daemon/v1/instance/ca",
    ),
    "panel.example.com",
  );

  const app = new Hono();
  registerDaemonApiRoutes(app, {
    tlsPublic: true,
    platformCaLeafPresented: (hostname) =>
      Promise.resolve(hostnamePresentsPlatformCaLeaf(hostname, stored)),
    readPlatformCaPem: () => Promise.resolve(ca.certificatePem),
  });
  const served = await app.request(
    `http://panel.example.com:8443${DAEMON_API_PREFIX}/instance/ca`,
  );
  assertEquals(served.status, 200);
  const anchor = await served.text();
  assertEquals(anchor, ca.certificatePem);
  assertEquals(served.headers.get("content-type"), "application/x-pem-file");
  assertEquals(
    await verifyCertificateSignature(leaf.certificatePem, anchor),
    true,
  );

  const hidden = await app.request(
    `http://acme.example.com${DAEMON_API_PREFIX}/instance/ca`,
  );
  assertEquals(hidden.status, 404);

  const env = {
    TURBOPANEL_TLS_PUBLIC: "1",
    TURBOPANEL_TLS_UPLOADED_PUBLIC: "1",
  };
  const command = installCommandFor(origin, undefined, stored, env);
  assertEquals(bootstrapsInsecure(command), true);
  assertEquals(
    command.includes("TURBOPANEL_HOST=https://panel.example.com:8443"),
    true,
  );
  assertEquals(
    unlistedSelfHostedInstallRefusal(origin, {
      selfHostedListener: true,
      leafNames: [...leaf.parsed.dnsNames, ...leaf.parsed.ipAddresses],
    }),
    null,
  );
  assertEquals(
    unlistedSelfHostedInstallRefusal("https://other.example.com:8443", {
      selfHostedListener: true,
      leafNames: leaf.parsed.dnsNames,
    }),
    UNLISTED_INSTALL_HOSTNAME_UNCOVERED,
  );

  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("TURBOPANEL_TLS_CERTS_DIR");
  Deno.env.set("TURBOPANEL_TLS_CERTS_DIR", dir);
  try {
    await Deno.writeTextFile(`${dir}/platform-ca.crt`, leaf.certificatePem);
    const names = await readPlatformCaLeafNames();
    assertEquals(names?.includes("panel.example.com"), true);
    assertEquals(
      await uploadedCertificateChainsToPublicRoot(privateLeaf.certificatePem),
      false,
    );

    const db = memoryInstallDb(
      [
        hostnameRow("https://acme.example.com:8443", "lets-encrypt", null),
        hostnameRow(
          "https://private.example.com:8443",
          "uploaded",
          "cert-private",
        ),
      ],
      [{
        id: "cert-private",
        certPem: `${privateLeaf.certificatePem}\n${ca.certificatePem}`,
      }],
    );
    const covered = await resolveInstallOriginTls(db, origin, env, true);
    assertEquals(covered.ok, true);
    if (!covered.ok) {
      throw new TypeError("expected the covered name to install");
    }
    assertEquals(covered.insecureTls, true);
    const fromRoute = buildLicenseInstallCommand({
      runtime: "deno",
      instanceUrl: origin,
      licenseId: "lic",
      licenseToken: "tok",
      insecureTls: covered.insecureTls,
    });
    assertEquals(bootstrapsInsecure(fromRoute), true);

    const refused = await resolveInstallOriginTls(
      db,
      "https://other.example.com:8443",
      env,
      true,
    );
    assertEquals(refused.ok, false);
    if (refused.ok) {
      throw new TypeError("expected an uncovered name to be refused");
    }
    assertEquals(refused.error, UNLISTED_INSTALL_HOSTNAME_UNCOVERED);

    const acme = await resolveInstallOriginTls(
      db,
      "https://acme.example.com:8443",
      env,
      true,
    );
    assertEquals(acme.ok, true);
    if (!acme.ok) {
      throw new TypeError("expected the Let's Encrypt name to install");
    }
    assertEquals(acme.insecureTls, false);

    const uploaded = await resolveInstallOriginTls(
      db,
      "https://private.example.com:8443",
      env,
      true,
    );
    assertEquals(uploaded.ok, true);
    if (!uploaded.ok) {
      throw new TypeError("expected the private upload to install");
    }
    assertEquals(uploaded.insecureTls, true);
  } finally {
    if (previous === undefined) Deno.env.delete("TURBOPANEL_TLS_CERTS_DIR");
    else Deno.env.set("TURBOPANEL_TLS_CERTS_DIR", previous);
    await Deno.remove(dir, { recursive: true });
  }
});

test("a private upload without a covering issuer is not an install command", async () => {
  const ca = await mintOrganizationCa({
    organizationId: "install-trust-missing",
  });
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ["private.example.com"],
  );
  const other = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ["other.example.com"],
  );
  const env = { TURBOPANEL_TLS_PUBLIC: "1" };
  const origin = "https://private.example.com:8443";
  const leafOnly = memoryInstallDb(
    [
      hostnameRow("https://acme.example.com:8443", "lets-encrypt", null),
      hostnameRow(origin, "uploaded", "cert-private"),
    ],
    [{ id: "cert-private", certPem: leaf.certificatePem }],
  );
  const refused = await resolveInstallOriginTls(leafOnly, origin, env, true);
  assertEquals(refused.ok, false);
  if (refused.ok) {
    throw new TypeError("expected a leaf-only private upload to be refused");
  }
  assertEquals(
    refused.error,
    privateUploadedTrustUnavailable("private.example.com"),
  );
  assertEquals(refused.error.includes("TURBOPANEL_LICENSE"), false);
  assertEquals(refused.error.includes("curl "), false);

  const mismatch = memoryInstallDb(
    [
      hostnameRow("https://acme.example.com:8443", "lets-encrypt", null),
      hostnameRow(origin, "uploaded", "cert-other"),
    ],
    [{
      id: "cert-other",
      certPem: `${other.certificatePem}\n${ca.certificatePem}`,
    }],
  );
  const uncovered = await resolveInstallOriginTls(mismatch, origin, env, true);
  assertEquals(uncovered.ok, false);
  if (uncovered.ok) {
    throw new TypeError(
      "expected a certificate for another name to be refused",
    );
  }
  assertEquals(
    uncovered.error,
    privateUploadedTrustUnavailable("private.example.com"),
  );
});

async function systemTrustedPem(): Promise<string> {
  const bundle = await Deno.readTextFile("/etc/ssl/certs/ca-certificates.crt");
  const blocks = [
    ...bundle.matchAll(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ),
  ].map((match) => match[0]);
  for (const block of blocks.slice(0, 40)) {
    if (await uploadedCertificateChainsToPublicRoot(block)) return block;
  }
  throw new TypeError("expected a certificate the system trust store accepts");
}

async function presentedLeafExchange(
  cert: string,
  key: string,
  caCerts: string[],
): Promise<{ first: string; second: string }> {
  const ac = new AbortController();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    cert,
    key,
    signal: ac.signal,
    onListen() {},
  }, () => new Response("enrolled"));
  const addr = server.addr;
  const port = typeof addr === "object" && addr && "port" in addr
    ? addr.port
    : 0;
  const client = Deno.createHttpClient({ caCerts });
  try {
    const first = await fetch(
      `https://127.0.0.1:${port}/api/daemon/v1/enroll`,
      {
        client,
      },
    );
    const firstBody = await first.text();
    const second = await fetch(
      `https://127.0.0.1:${port}/api/daemon/v1/enroll`,
      { client },
    );
    const secondBody = await second.text();
    return {
      first: `${first.status} ${firstBody}`,
      second: `${second.status} ${secondBody}`,
    };
  } finally {
    client.close();
    ac.abort();
    await server.finished.catch(() => undefined);
  }
}

test("a private upload with a Let's Encrypt sibling enrolls from its issuer while a public upload keeps system roots", async () => {
  const ca = await mintOrganizationCa({
    organizationId: "install-trust-enroll",
  });
  const privateLeaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ["private.example.com"],
    { ipAddresses: ["127.0.0.1"] },
  );
  const publicPem = await systemTrustedPem();
  const platformCa =
    "-----BEGIN CERTIFICATE-----\nNOT-THE-UPLOAD-ISSUER\n-----END CERTIFICATE-----\n";
  const privateOrigin = "https://private.example.com:8443";
  const publicOrigin = "https://public.example.com:8443";
  const env = { TURBOPANEL_TLS_PUBLIC: "1" };
  const db = memoryInstallDb(
    [
      hostnameRow("https://acme.example.com:8443", "lets-encrypt", null),
      hostnameRow(privateOrigin, "uploaded", "cert-private"),
      hostnameRow(publicOrigin, "uploaded", "cert-public"),
    ],
    [
      {
        id: "cert-private",
        certPem: `${privateLeaf.certificatePem}\n${ca.certificatePem}`,
      },
      { id: "cert-public", certPem: publicPem },
    ],
  );
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDaemonApiRoutes(app, {
    tlsPublic: true,
    platformCaLeafPresented: (hostname) =>
      Promise.resolve(hostname === "panel.example.com"),
    readPlatformCaPem: () => Promise.resolve(platformCa),
  });

  const hiddenCa = await app.request(
    `http://private.example.com:8443${DAEMON_API_PREFIX}/instance/ca`,
  );
  assertEquals(hiddenCa.status, 404);

  const trust = await app.request(
    `http://private.example.com:8443${DAEMON_API_PREFIX}/instance/uploaded-trust`,
  );
  assertEquals(trust.status, 200);
  assertEquals(trust.headers.get("content-type"), "application/x-pem-file");
  const issuer = await trust.text();
  assertEquals(issuer === platformCa, false);
  assertEquals(
    await verifyCertificateSignature(privateLeaf.certificatePem, issuer),
    true,
  );

  const enrolled = await presentedLeafExchange(
    privateLeaf.certificatePem,
    privateLeaf.privateKeyPem,
    [issuer],
  );
  assertEquals(enrolled.first, "200 enrolled");
  assertEquals(enrolled.second, "200 enrolled");

  const ac = new AbortController();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    cert: privateLeaf.certificatePem,
    key: privateLeaf.privateKeyPem,
    signal: ac.signal,
    onListen() {},
  }, () => new Response("enrolled"));
  const addr = server.addr;
  const port = typeof addr === "object" && addr && "port" in addr
    ? addr.port
    : 0;
  let systemRootsRejected = false;
  try {
    await fetch(`https://127.0.0.1:${port}/api/daemon/v1/enroll`);
  } catch {
    systemRootsRejected = true;
  } finally {
    ac.abort();
    await server.finished.catch(() => undefined);
  }
  assertEquals(systemRootsRejected, true);

  const prepared = await resolveInstallOriginTls(db, privateOrigin, env, true);
  assertEquals(prepared.ok, true);
  if (!prepared.ok) {
    throw new TypeError(
      "expected the private upload with an issuer to install",
    );
  }
  assertEquals(prepared.insecureTls, true);

  const published = await resolveInstallOriginTls(db, publicOrigin, env, true);
  assertEquals(published.ok, true);
  if (!published.ok) {
    throw new TypeError("expected the public upload to install");
  }
  assertEquals(published.insecureTls, false);
  const publicTrust = await app.request(
    `http://public.example.com:8443${DAEMON_API_PREFIX}/instance/uploaded-trust`,
  );
  assertEquals(publicTrust.status, 404);
  const command = buildLicenseInstallCommand({
    runtime: "deno",
    instanceUrl: publicOrigin,
    licenseId: "lic",
    licenseToken: "tok",
    insecureTls: published.insecureTls,
  });
  assertEquals(bootstrapsInsecure(command), false);
  assertEquals(command.includes("TURBOPANEL_INSECURE_TLS"), false);
  assertEquals(command.includes("curl -fsSLk"), false);
});

const FORWARDED_LAN_IP = "192.168.1.10";
const UNLISTED_LAN_ALIAS = "dev.lan";

async function opensslNameMatches(
  flag: "-verify_hostname" | "-verify_ip",
  caPem: string,
  leafPem: string,
  name: string,
): Promise<boolean> {
  const dir = await Deno.makeTempDir();
  const caPath = `${dir}/ca.pem`;
  const leafPath = `${dir}/leaf.pem`;
  await Deno.writeTextFile(caPath, caPem);
  await Deno.writeTextFile(leafPath, leafPem);
  try {
    const result = await new Deno.Command("openssl", {
      args: [
        "verify",
        flag,
        name,
        "-partial_chain",
        "-CAfile",
        caPath,
        leafPath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return result.code === 0;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function systemRootsRejectPresentedLeaf(
  cert: string,
  key: string,
): Promise<boolean> {
  const ac = new AbortController();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    cert,
    key,
    signal: ac.signal,
    onListen() {},
  }, () => new Response("enrolled"));
  const addr = server.addr;
  const port = typeof addr === "object" && addr && "port" in addr
    ? addr.port
    : 0;
  try {
    await fetch(`https://127.0.0.1:${port}/api/daemon/v1/enroll`);
    return false;
  } catch {
    return true;
  } finally {
    ac.abort();
    await server.finished.catch(() => undefined);
  }
}

test("a forwarded LAN IP on the Platform CA leaf is accepted and an unlisted alias is refused", async () => {
  const ca = await mintOrganizationCa({ organizationId: "install-lan-san" });
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ["localhost"],
    { ipAddresses: [FORWARDED_LAN_IP, "127.0.0.1"] },
  );
  const names = [...leaf.parsed.dnsNames, ...leaf.parsed.ipAddresses];
  const covered = {
    selfHostedListener: true,
    leafNames: names,
  };
  assertEquals(
    unlistedSelfHostedInstallRefusal(
      `https://${FORWARDED_LAN_IP}:8443`,
      covered,
    ),
    null,
  );
  assertEquals(
    unlistedSelfHostedInstallRefusal(
      `https://${UNLISTED_LAN_ALIAS}:8443`,
      covered,
    ),
    UNLISTED_INSTALL_HOSTNAME_UNCOVERED,
  );
  assertEquals(
    unlistedSelfHostedInstallRefusal(`https://${UNLISTED_LAN_ALIAS}:8443`, {
      ...covered,
      source: "platform-ca",
    }),
    UNLISTED_INSTALL_HOSTNAME_UNCOVERED,
  );
  assertEquals(
    unlistedSelfHostedInstallRefusal(`https://${UNLISTED_LAN_ALIAS}:8443`, {
      ...covered,
      source: "lets-encrypt",
    }),
    null,
  );
  assertEquals(
    unlistedSelfHostedInstallRefusal(`https://${FORWARDED_LAN_IP}:8443`, {
      selfHostedListener: true,
      leafNames: null,
    }),
    UNLISTED_INSTALL_HOSTNAME_UNCOVERED,
  );

  assertEquals(
    await opensslNameMatches(
      "-verify_ip",
      ca.certificatePem,
      leaf.certificatePem,
      FORWARDED_LAN_IP,
    ),
    true,
  );
  assertEquals(
    await opensslNameMatches(
      "-verify_hostname",
      ca.certificatePem,
      leaf.certificatePem,
      UNLISTED_LAN_ALIAS,
    ),
    false,
  );

  const enrolled = await presentedLeafExchange(
    leaf.certificatePem,
    leaf.privateKeyPem,
    [ca.certificatePem],
  );
  assertEquals(enrolled.first, "200 enrolled");
  assertEquals(enrolled.second, "200 enrolled");
  assertEquals(
    await systemRootsRejectPresentedLeaf(
      leaf.certificatePem,
      leaf.privateKeyPem,
    ),
    true,
  );

  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("TURBOPANEL_TLS_CERTS_DIR");
  Deno.env.set("TURBOPANEL_TLS_CERTS_DIR", dir);
  try {
    await Deno.writeTextFile(`${dir}/self-signed.crt`, leaf.certificatePem);
    const read = await readPlatformCaLeafNames();
    assertEquals(read?.includes(FORWARDED_LAN_IP), true);
    const db = memoryInstallDb([], []);
    const ip = await resolveInstallOriginTls(
      db,
      `https://${FORWARDED_LAN_IP}:8443`,
      {},
      true,
    );
    assertEquals(ip.ok, true);
    if (!ip.ok) {
      throw new TypeError("expected the covered LAN IP to install");
    }
    assertEquals(ip.insecureTls, true);
    const alias = await resolveInstallOriginTls(
      db,
      `https://${UNLISTED_LAN_ALIAS}:8443`,
      {},
      true,
    );
    assertEquals(alias.ok, false);
    if (alias.ok) {
      throw new TypeError("expected the unlisted alias to be refused");
    }
    assertEquals(alias.error, UNLISTED_INSTALL_HOSTNAME_UNCOVERED);
  } finally {
    if (previous === undefined) Deno.env.delete("TURBOPANEL_TLS_CERTS_DIR");
    else Deno.env.set("TURBOPANEL_TLS_CERTS_DIR", previous);
    await Deno.remove(dir, { recursive: true });
  }
});

function firstForwardedIpv4(text: string): string | null {
  for (const line of text.split("\n")) {
    const token = line.trim();
    const parts = token.split(".");
    if (parts.length !== 4) continue;
    const ipv4 = parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number(part);
      return value <= 255 && String(value) === part;
    });
    if (ipv4) return token;
  }
  return null;
}

async function liveCatchAllLeafPath(): Promise<string> {
  const home = Deno.env.get("HOME") ?? "";
  const candidates = [
    `${home}/turbopanel/certs/platform-ca.crt`,
    `${home}/turbopanel/certs/self-signed.crt`,
    "/var/lib/turbopanel/tls/certs/platform-ca.crt",
    "/var/lib/turbopanel/tls/certs/self-signed.crt",
  ];
  for (const path of candidates) {
    try {
      await Deno.stat(path);
      return path;
    } catch {
      // The next candidate is the leaf this host actually serves.
    }
  }
  throw new TypeError("Platform CA catch-all leaf was not found");
}

async function curlHttpStatus(args: readonly string[]): Promise<number> {
  const result = await new Deno.Command("curl", {
    args: ["-sS", "-o", "/dev/null", "-w", "%{http_code}", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const code = Number(new TextDecoder().decode(result.stdout).trim());
  return Number.isFinite(code) ? code : 0;
}

test({
  name:
    "Vagrant :8443 forward verifies a covered LAN IP and rejects an unlisted alias",
  ignore: Deno.env.get("TURBOPANEL_VERIFY_VAGRANT_FORWARD") !== "1",
  fn: async () => {
    const hosts = await Deno.readTextFile("/etc/turbopanel/dev-forward-hosts");
    const ip = firstForwardedIpv4(hosts);
    if (!ip) throw new TypeError("dev-forward-hosts has no IPv4 address");
    const caPath = "/var/lib/turbopanel/tls/ca.crt";
    const leafPath = await liveCatchAllLeafPath();
    const caPem = await Deno.readTextFile(caPath);
    const leafPem = await Deno.readTextFile(leafPath);
    assertEquals(
      await opensslNameMatches("-verify_ip", caPem, leafPem, ip),
      true,
    );
    assertEquals(
      await opensslNameMatches(
        "-verify_hostname",
        caPem,
        leafPem,
        UNLISTED_LAN_ALIAS,
      ),
      false,
    );
    const origin = `https://${ip}:8443`;
    assertEquals(
      await curlHttpStatus(["--cacert", caPath, `${origin}/api/health`]),
      200,
    );
    assertEquals(
      await curlHttpStatus([
        "--cacert",
        caPath,
        `${origin}/api/client/v1/status`,
      ]),
      200,
    );
    assertEquals(
      await curlHttpStatus([
        "--cacert",
        caPath,
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "-d",
        "{}",
        `${origin}/api/daemon/v1/enroll`,
      ]),
      401,
    );
  },
});

test("the public-trust check uses the host's default OpenSSL store, not a hard-coded Debian bundle", async () => {
  const publicPem = await systemTrustedPem();
  // SSL_CERT_FILE / SSL_CERT_DIR are how a host (or its distribution) points
  // OpenSSL's default store elsewhere. An empty store must make the check
  // fail; a hard-coded `-CAfile /etc/ssl/certs/…` ignored them, which is why
  // RHEL-family hosts (whose bundle lives under /etc/pki) read every public
  // upload as private.
  const emptyDir = await Deno.makeTempDir({ prefix: "tp-empty-ca-" });
  const emptyFile = `${emptyDir}/empty.pem`;
  await Deno.writeTextFile(emptyFile, "");
  const saved = {
    file: Deno.env.get("SSL_CERT_FILE"),
    dir: Deno.env.get("SSL_CERT_DIR"),
  };
  try {
    Deno.env.set("SSL_CERT_FILE", emptyFile);
    Deno.env.set("SSL_CERT_DIR", emptyDir);
    assertEquals(await uploadedCertificateChainsToPublicRoot(publicPem), false);
  } finally {
    if (saved.file === undefined) Deno.env.delete("SSL_CERT_FILE");
    else Deno.env.set("SSL_CERT_FILE", saved.file);
    if (saved.dir === undefined) Deno.env.delete("SSL_CERT_DIR");
    else Deno.env.set("SSL_CERT_DIR", saved.dir);
    await Deno.remove(emptyDir, { recursive: true });
  }
  assertEquals(await uploadedCertificateChainsToPublicRoot(publicPem), true);
});

test("repeated uploaded-trust requests for one name do not spawn openssl again", async () => {
  const ca = await mintOrganizationCa({ organizationId: "install-trust-cache" });
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ["cached.example.com"],
  );
  const origin = "https://cached.example.com:8443";
  const db = memoryInstallDb(
    [hostnameRow(origin, "uploaded", "cert-cached")],
    [{ id: "cert-cached", certPem: `${leaf.certificatePem}\n${ca.certificatePem}` }],
  );
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDaemonApiRoutes(app, { tlsPublic: true });

  const Original = Deno.Command;
  let spawns = 0;
  class Counting extends Original {
    constructor(command: string | URL, options?: Deno.CommandOptions) {
      if (String(command).endsWith("openssl")) spawns += 1;
      super(command, options);
    }
  }
  Object.defineProperty(Deno, "Command", {
    value: Counting,
    configurable: true,
    writable: true,
  });
  try {
    const url =
      `http://cached.example.com:8443${DAEMON_API_PREFIX}/instance/uploaded-trust`;
    const first = await app.request(url);
    assertEquals(first.status, 200);
    const afterFirst = spawns;
    assertEquals(afterFirst >= 1, true);
    for (let i = 0; i < 3; i++) {
      const again = await app.request(url);
      assertEquals(again.status, 200);
      assertEquals(await again.text(), await first.clone().text());
    }
    assertEquals(spawns, afterFirst);
  } finally {
    Object.defineProperty(Deno, "Command", {
      value: Original,
      configurable: true,
      writable: true,
    });
  }
});
