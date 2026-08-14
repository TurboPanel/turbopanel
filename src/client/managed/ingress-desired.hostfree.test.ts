import { assertEquals, assertRejects } from "jsr:@std/assert";
import type { Db } from "../../db.ts";
import { loadBoundManagedIdsForServer } from "./ingress-desired.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

test("loadBoundManagedIdsForServer scopes the binding query by org and server", async () => {
  let whereCount = 0;
  const db = {
    select() {
      const query = {
        innerJoin() {
          return query;
        },
        leftJoin() {
          return query;
        },
        where() {
          whereCount += 1;
          return thenable([]);
        },
      };
      return {
        from() {
          return query;
        },
      };
    },
  } as unknown as Db;

  const ids = await loadBoundManagedIdsForServer(db, "srv-1", "org-1");
  assertEquals(ids, []);
  assertEquals(whereCount, 1);
});

test("loadBoundManagedIdsForServer fails closed when the binding query is unscoped", async () => {
  const db = {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return this;
            },
            leftJoin() {
              return this;
            },
          };
        },
      };
    },
  } as unknown as Db;

  await assertRejects(
    () => loadBoundManagedIdsForServer(db, "srv-1", "org-1"),
    TypeError,
  );
});
