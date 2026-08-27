import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  evaluateLicensePolicy,
  type NoticePackage,
  packagesFromDenoLock,
  type PnpmLicenseEntry,
  renderThirdPartyNotices,
} from "../src/lib/notices.ts";
import { runGenerateNotices } from "./generate-notices.ts";

describe("generate-notices deno.lock npm", () => {
  it("includes deno.lock npm entries in markdown and policy", async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-notices-" });
    try {
      await Deno.writeTextFile(
        join(root, "pnpm-lock.yaml"),
        "lockfileVersion: 9.0\n",
      );
      await Deno.writeTextFile(
        join(root, "deno.lock"),
        JSON.stringify({
          version: "5",
          jsr: { "@std/assert@1.0.19": { integrity: "abc" } },
          npm: {
            "yaml@2.9.0": { integrity: "def" },
            "only-in-deno@1.2.3": { integrity: "ghi" },
            "@babel/helper-module-transforms@7.29.7_@babel+core@7.29.7": {
              integrity: "jkl",
            },
          },
        }),
      );

      const pnpmGrouped: Record<string, PnpmLicenseEntry[]> = {
        ISC: [{ name: "yaml", versions: ["2.9.0"], license: "ISC" }],
      };
      const licenses: Record<string, string> = {
        "@std/assert@1.0.19": "MIT",
        "only-in-deno@1.2.3": "MIT",
        "@babel/helper-module-transforms@7.29.7": "MIT",
      };

      const code = await runGenerateNotices({
        root,
        argv: [],
        io: { log: () => {}, error: () => {} },
        exit: () => {},
        loadPnpmLicenses: () => Promise.resolve(pnpmGrouped),
        denoProductionRoots: [
          "jsr:@std/assert@1.0.19",
          "npm:yaml@2.9.0",
          "npm:only-in-deno@1.2.3",
          "npm:@babel/helper-module-transforms@7.29.7",
        ],
        lookupLicense: async (pkg: NoticePackage) =>
          licenses[`${pkg.name}@${pkg.version}`] ?? "",
      });
      assertEquals(code, 0);
      const markdown = await Deno.readTextFile(
        join(root, "THIRD_PARTY_NOTICES.md"),
      );
      assertStringIncludes(markdown, "### only-in-deno@1.2.3");
      assertStringIncludes(markdown, "deno.lock (npm)");
      assertStringIncludes(
        markdown,
        "### @babel/helper-module-transforms@7.29.7",
      );
      assertStringIncludes(markdown, "### yaml@2.9.0");

      const denoNpm = packagesFromDenoLock(
        {
          npm: {
            "only-in-deno@1.2.3": {},
            "copyleft-only@9.0.0": {},
          },
        },
        {
          "only-in-deno@1.2.3": "MIT",
          "copyleft-only@9.0.0": "GPL-3.0-only",
        },
      );
      const policy = evaluateLicensePolicy(denoNpm);
      assertEquals(policy.some((row) => row.name === "copyleft-only"), true);
      assertEquals(
        policy.find((row) => row.name === "copyleft-only")?.reason,
        "copyleft-production",
      );
      assertEquals(policy.some((row) => row.name === "only-in-deno"), false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("generate-notices policy", () => {
  it("fails when a Deno npm package has an unreviewed license", async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-notices-policy-" });
    try {
      await Deno.writeTextFile(
        join(root, "pnpm-lock.yaml"),
        "lockfileVersion: 9.0\n",
      );
      await Deno.writeTextFile(
        join(root, "deno.lock"),
        JSON.stringify({
          version: "5",
          npm: { "copyleft-only@9.0.0": { integrity: "x" } },
        }),
      );
      const errors: string[] = [];
      const code = await runGenerateNotices({
        root,
        argv: [],
        io: {
          log: () => {},
          error: (...args: unknown[]) => {
            errors.push(args.map(String).join(" "));
          },
        },
        exit: () => {},
        loadPnpmLicenses: () => Promise.resolve({}),
        denoProductionRoots: ["npm:copyleft-only@9.0.0"],
        lookupLicense: async () => "GPL-3.0-only",
      });
      assertEquals(code, 1);
      assertStringIncludes(errors.join("\n"), "copyleft-only@9.0.0");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("generate-notices production graph", () => {
  it("keeps test, build, and stale lock entries out of Production", () => {
    const packages = packagesFromDenoLock(
      {
        specifiers: {
          "jsr:@std/path@1": "1.1.5",
          "jsr:@std/testing@1": "1.0.19",
          "npm:yaml@^2.8.0": "2.9.0",
          "npm:vitest@^4.1.0": "4.1.10",
          "npm:wrangler@^4.124.0": "4.124.0",
        },
        workspace: {
          dependencies: [
            "jsr:@std/path@1",
            "jsr:@std/testing@1",
            "npm:yaml@^2.8.0",
          ],
          packageJson: {
            dependencies: [
              "npm:vitest@^4.1.0",
              "npm:wrangler@^4.124.0",
            ],
          },
        },
        jsr: {
          "@std/path@1.1.5": { integrity: "a" },
          "@std/testing@1.0.19": { integrity: "b" },
        },
        npm: {
          "yaml@2.9.0": { integrity: "c" },
          "vitest@4.1.10": { integrity: "d" },
          "wrangler@4.124.0": { integrity: "e" },
          "wrangler@4.122.0": { integrity: "stale-wrangler" },
          "stale-unreferenced@9.9.9": { integrity: "f" },
        },
      },
      {
        "@std/path@1.1.5": "MIT",
        "@std/testing@1.0.19": "MIT",
        "yaml@2.9.0": "ISC",
        "vitest@4.1.10": "MIT",
        "wrangler@4.124.0": "MIT OR Apache-2.0",
        "wrangler@4.122.0": "MIT OR Apache-2.0",
        "stale-unreferenced@9.9.9": "MIT",
      },
      {
        productionRoots: ["jsr:@std/path@1", "npm:yaml@^2.8.0"],
      },
    );
    const production = packages.filter((row) => row.role === "production");
    const development = packages.filter((row) => row.role === "development");
    assertEquals(
      production.map((row) => `${row.name}@${row.version}`).sort((a, b) =>
        a.localeCompare(b)
      ),
      ["@std/path@1.1.5", "yaml@2.9.0"],
    );
    assertEquals(
      development.map((row) => row.name).sort((a, b) => a.localeCompare(b)),
      ["@std/testing", "vitest", "wrangler"],
    );
    assertEquals(
      packages.some((row) => row.name === "stale-unreferenced"),
      false,
    );
    const markdown = renderThirdPartyNotices(packages, {
      repoLicense: "AGPL-3.0-only",
      productName: "TurboPanel Control Plane",
      regenerateCommand: "deno task notices:generate",
      lockfileFingerprints: { "deno.lock": "sha256:test" },
    });
    const productionSection = markdown.slice(
      markdown.indexOf("## Production dependencies"),
      markdown.indexOf("## Development-only dependencies"),
    );
    assertEquals(productionSection.includes("@std/testing"), false);
    assertEquals(productionSection.includes("vitest@"), false);
    assertEquals(productionSection.includes("wrangler@"), false);
    assertEquals(productionSection.includes("stale-unreferenced"), false);
    assertEquals(markdown.includes("### stale-unreferenced@9.9.9"), false);
  });
});
