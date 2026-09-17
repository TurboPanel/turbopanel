import { assertEquals } from "@std/assert";
import {
  DEFAULT_STATE_DIR,
  defaultLeafCertsDir,
} from "./generate-self-signed-cert.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("defaultLeafCertsDir is <state>/tls/certs, inside the compiled binary's --allow-write tree", () => {
  assertEquals(DEFAULT_STATE_DIR, "/var/lib/turbopanel");
  assertEquals(defaultLeafCertsDir({}), "/var/lib/turbopanel/tls/certs");
  assertEquals(
    defaultLeafCertsDir({ TURBOPANEL_STATE_DIR: " " }),
    "/var/lib/turbopanel/tls/certs",
  );
  assertEquals(
    defaultLeafCertsDir({ TURBOPANEL_STATE_DIR: "/srv/tp/state/" }),
    "/srv/tp/state/tls/certs",
  );
});
