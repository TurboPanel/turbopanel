import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import type { ServerMetadata, ServerOptions } from "../../lib/db/server-metadata.ts";
import { resolveCellLocationHint } from "./location.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const serverId = "srv-location-test";

type MockRow = {
  metadata: ServerMetadata | null;
  options: ServerOptions | null;
};

function createMockDb(row: MockRow | null): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  } as unknown as Db;
}

test("resolveCellLocationHint prefers options over metadata", async () => {
  const db = createMockDb({
    metadata: { cell: { locationHint: "meta-hint" } },
    options: { cellLocationHint: "options-hint" },
  });
  assertEquals(await resolveCellLocationHint(db, serverId), "options-hint");
});

test("resolveCellLocationHint falls back to metadata when options omit hint", async () => {
  const db = createMockDb({
    metadata: { cell: { locationHint: "meta-only" } },
    options: {},
  });
  assertEquals(await resolveCellLocationHint(db, serverId), "meta-only");
});

test("resolveCellLocationHint returns undefined when no row exists", async () => {
  const db = createMockDb(null);
  assertEquals(await resolveCellLocationHint(db, serverId), undefined);
});

test("resolveCellLocationHint returns undefined when neither column defines a hint", async () => {
  const db = createMockDb({ metadata: {}, options: {} });
  assertEquals(await resolveCellLocationHint(db, serverId), undefined);
});

test("resolveCellLocationHint treats null options as metadata-only", async () => {
  const db = createMockDb({
    metadata: { cell: { locationHint: "from-meta" } },
    options: null,
  });
  assertEquals(await resolveCellLocationHint(db, serverId), "from-meta");
});

test("resolveCellLocationHint ignores a cell block without locationHint", async () => {
  const db = createMockDb({
    metadata: { cell: {} },
    options: null,
  });
  assertEquals(await resolveCellLocationHint(db, serverId), undefined);
});

test("resolveCellLocationHint uses options when metadata is null", async () => {
  const db = createMockDb({
    metadata: null,
    options: { cellLocationHint: "from-options" },
  });
  assertEquals(await resolveCellLocationHint(db, serverId), "from-options");
});
