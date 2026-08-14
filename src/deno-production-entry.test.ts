import { assert } from "@std/assert";
import { it } from "@std/testing/bdd";

it("production Deno entry does not import developer modules", async () => {
  const entry = await Deno.readTextFile(new URL("./deno.ts", import.meta.url));
  assert(
    !entry.includes("developer/"),
    "src/deno.ts must not import developer modules",
  );
  assert(
    !entry.includes("registerVersionRoute"),
    "src/deno.ts must not register /api/daemon/v1/version",
  );
  assert(
    entry.includes("startDenoServer()"),
    "src/deno.ts must start the production server without a developer registrar",
  );
});

it("development Deno entry registers the developer surface", async () => {
  const entry = await Deno.readTextFile(new URL("./deno-dev.ts", import.meta.url));
  assert(entry.includes("registerDeveloperRoutes"));
  assert(entry.includes("registerVersionRoute"));
  assert(entry.includes("registerDevSyncRoutes"));
});
