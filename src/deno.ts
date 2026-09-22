/**
 * Production Deno entry. Does not import developer modules so `deno task compile`
 * keeps those routes, git/tar/node grants, and Drizzle Studio out of the binary.
 * Development source mode uses {@link ./deno-dev.ts}.
 *
 * `duckdb-smoke <write|verify|parquet>` runs the embedded-DuckDB packaging
 * probe instead of starting the server, so `deno task duckdb:smoke`
 * (scripts/duckdb-compile-smoke.ts) exercises the exact compiled artifact
 * that ships. `migrate`, `generate-secret` and `generate-self-signed-cert`
 * are the install-time verbs a compiled instance needs without a checkout
 * (src/cli/). All imported lazily: the server path must not load the DuckDB
 * native addon, the migrator or openssl at startup.
 */
/**
 * Install-time subcommands (instance-runtime-packaging, Road to 0.1.x): what
 * the installer used to reach into a source checkout for. Each is imported
 * lazily so the server path loads none of it.
 */
switch (Deno.args[0]) {
  case "duckdb-smoke": {
    const { runDuckdbSmoke } = await import("./cli/duckdb-smoke.ts");
    await runDuckdbSmoke(Deno.args[1] ?? "");
    break;
  }
  case "migrate": {
    const { runMigrateCommand } = await import("./cli/migrate.ts");
    Deno.exit(await runMigrateCommand());
    break;
  }
  case "generate-secret": {
    const { runGenerateSecretCommand } = await import(
      "./cli/generate-secret.ts"
    );
    runGenerateSecretCommand();
    break;
  }
  case "generate-self-signed-cert": {
    const { runGenerateSelfSignedCertCommand } = await import(
      "./cli/generate-self-signed-cert.ts"
    );
    await runGenerateSelfSignedCertCommand();
    break;
  }
  default: {
    // Lazy for the same reason: the server graph loads the DuckDB addon at
    // module evaluation (it needs the vendored libduckdb.so on
    // LD_LIBRARY_PATH), which an install-time verb run before the unit
    // exists must not require.
    const { startDenoServer } = await import("./platform/deno/server.ts");
    await startDenoServer();
  }
}
