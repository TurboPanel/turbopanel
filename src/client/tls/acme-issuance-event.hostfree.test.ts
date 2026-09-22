/**
 * Host-free coverage for daemon-observed ACME issuance events (Db doubles only).
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db/connection.ts";
import { handleAcmeIssuanceEvent } from "./acme-issuance-event.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Row = {
  id: string;
  status: string;
  metadata: unknown;
};

const SERVER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORG_ID = "00000000-0000-4000-8000-0000000000bb";

/**
 * Two selects in order: the reporting server's organization (scoping the
 * write), then that organization's lets_encrypt rows. `organizationId: null`
 * stands in for a server that is enrolled but not yet placed in one.
 */
function fakeDb(
  rows: Row[],
  opts: { organizationId?: string | null } = {},
): { db: Db; updates: Array<{ id: string; patch: Record<string, unknown> }> } {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const organizationId = opts.organizationId === undefined
    ? ORG_ID
    : opts.organizationId;
  const managedIds = rows.filter((r) => r.status === "managed").map((r) =>
    r.id
  );
  let updateIndex = 0;
  let selectCall = 0;
  const db = {
    select: () => ({
      from: () => {
        const isServerLookup = selectCall++ === 0;
        if (isServerLookup) {
          const serverRows =
            organizationId === null && opts.organizationId === null
              ? [{ organizationId: null }]
              : organizationId === undefined
              ? []
              : [{ organizationId }];
          return {
            where: () => ({ limit: () => Promise.resolve(serverRows) }),
          };
        }
        return { where: () => Promise.resolve(rows) };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          // Stand in for `eq(tls.id, row.id)` without re-implementing drizzle:
          // the handler walks the managed rows in order.
          const target = managedIds[updateIndex++] ?? rows[0]?.id ?? "";
          updates.push({ id: target, patch });
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Db;
  return { db, updates };
}

test("handleAcmeIssuanceEvent is a no-op when no row covers the hostname", async () => {
  const { db, updates } = fakeDb([]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: false,
    errorMessage: "boom",
  });
  assertEquals(result.updated, false);
  assertEquals(updates.length, 0);
});

test("handleAcmeIssuanceEvent skips a non-managed lets_encrypt row", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "pending",
      metadata: {
        dnsNames: ["app.example.com"],
        hasWildcard: false,
        notBefore: "",
        subject: "",
        issuer: "",
      },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: false,
    errorMessage: "boom",
  });
  assertEquals(result.updated, false);
  assertEquals(updates.length, 0);
});

test("handleAcmeIssuanceEvent skips a managed row whose dnsNames do not cover the hostname", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "managed",
      metadata: {
        dnsNames: ["other.example.com"],
        hasWildcard: false,
        notBefore: "",
        subject: "",
        issuer: "",
      },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: false,
    errorMessage: "boom",
  });
  assertEquals(result.updated, false);
  assertEquals(updates.length, 0);
});

test("handleAcmeIssuanceEvent writes lastError onto the matching managed row, leaving status untouched", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "managed",
      metadata: {
        dnsNames: ["app.example.com"],
        hasWildcard: false,
        notBefore: "",
        subject: "",
        issuer: "",
        acme: { challengeType: "http-01", managedBy: "caddy" },
      },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: false,
    errorMessage: "received fatal alert: InternalError",
  });
  assertEquals(result.updated, true);
  assertEquals(updates.length, 1);
  const patch = updates[0]!.patch;
  // The regression this guards: a visibility feature must never write
  // `status` — that column, not this jsonb field, is what
  // isReadyCandidate()/resolveTlsForHosting() gate deploys on.
  assertEquals("status" in patch, false);
  const metadata = patch.metadata as {
    acme?: { lastError?: string; managedBy?: string; challengeType?: string };
  };
  assertEquals(metadata.acme?.lastError, "received fatal alert: InternalError");
  // Sibling acme fields survive the merge-patch untouched.
  assertEquals(metadata.acme?.managedBy, "caddy");
  assertEquals(metadata.acme?.challengeType, "http-01");
});

test("handleAcmeIssuanceEvent falls back to a default message when the daemon sent none", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "managed",
      metadata: {
        dnsNames: ["app.example.com"],
        hasWildcard: false,
        notBefore: "",
        subject: "",
        issuer: "",
      },
    },
  ]);
  await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: false,
  });
  const metadata = updates[0]!.patch.metadata as {
    acme?: { lastError?: string };
  };
  assertEquals(metadata.acme?.lastError, "ACME issuance failed");
});

test("handleAcmeIssuanceEvent clears lastError on recovery, keeping other acme fields", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "managed",
      metadata: {
        dnsNames: ["app.example.com"],
        hasWildcard: false,
        notBefore: "",
        subject: "",
        issuer: "",
        acme: { lastError: "stale failure", managedBy: "caddy" },
      },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: true,
  });
  assertEquals(result.updated, true);
  const metadata = updates[0]!.patch.metadata as {
    acme?: { lastError?: string; managedBy?: string };
  };
  assertEquals("lastError" in (metadata.acme ?? {}), false);
  assertEquals(metadata.acme?.managedBy, "caddy");
});

test("handleAcmeIssuanceEvent matches a wildcard dnsNames entry", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "managed",
      metadata: {
        dnsNames: ["*.example.com"],
        hasWildcard: true,
        notBefore: "",
        subject: "",
        issuer: "",
      },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: false,
    errorMessage: "boom",
  });
  assertEquals(result.updated, true);
  assertEquals(updates.length, 1);
});

test("handleAcmeIssuanceEvent normalizes hostname casing and trailing dot before matching", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "managed",
      metadata: {
        dnsNames: ["app.example.com"],
        hasWildcard: false,
        notBefore: "",
        subject: "",
        issuer: "",
      },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "APP.example.com.",
    ok: false,
    errorMessage: "boom",
  });
  assertEquals(result.updated, true);
  assertEquals(updates.length, 1);
});

test("handleAcmeIssuanceEvent is a no-op for an empty hostname", async () => {
  const { db, updates } = fakeDb([
    {
      id: "tls-1",
      status: "managed",
      metadata: {
        dnsNames: ["app.example.com"],
        hasWildcard: false,
        notBefore: "",
        subject: "",
        issuer: "",
      },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "   ",
    ok: false,
    errorMessage: "boom",
  });
  assertEquals(result.updated, false);
  assertEquals(updates.length, 0);
});

test("an event only touches the reporting organization, and every row it covers", async () => {
  // Hostname uniqueness is per organization, so two organizations can hold
  // rows for the same hostname; the query is scoped to the reporting
  // server's organization, and within it every covering row is refreshed —
  // an older revoked-then-recreated pin must not keep a stale error.
  const { db, updates } = fakeDb([
    {
      id: "row-current",
      status: "managed",
      metadata: { dnsNames: ["app.example.com"] },
    },
    {
      id: "row-wildcard",
      status: "managed",
      metadata: { dnsNames: ["*.example.com"], acme: { lastError: "stale" } },
    },
  ]);
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: true,
  });
  assertEquals(result.updated, true);
  assertEquals(updates.map((u) => u.id), ["row-current", "row-wildcard"]);
  // A success clears the stale error rather than leaving it to be read later.
  for (const update of updates) {
    const metadata = update.patch.metadata as { acme?: { lastError?: string } };
    assertEquals(metadata.acme?.lastError, undefined);
  }
});

test("a server with no organization writes nothing", async () => {
  const { db, updates } = fakeDb(
    [
      {
        id: "row-other-org",
        status: "managed",
        metadata: { dnsNames: ["app.example.com"] },
      },
    ],
    { organizationId: null },
  );
  const result = await handleAcmeIssuanceEvent(db, {
    serverId: SERVER_ID,
    hostname: "app.example.com",
    ok: false,
    errorMessage: "boom",
  });
  assertEquals(result.updated, false);
  assertEquals(updates.length, 0);
});
