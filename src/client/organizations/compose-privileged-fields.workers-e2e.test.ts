/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.ts";
import { createWorkersDb, endDbConnection } from "../../db.ts";
import {
  grant,
  organization,
  session as sessionTable,
  user,
} from "../../lib/db/schema.ts";
import { registerOrganizationRoutes } from "./routes.ts";
import { deriveSecretsConfig } from "../authn/secrets.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { testSecretsEnvLine } from "../../test-fixtures/secrets.ts";
import { parseSecretsEnv } from "../authn/secrets.ts";
import {
  parseOrganizationOptions,
  resolveComposeGatedFieldsEnabled,
} from "../../lib/organization-options.ts";
import { validateComposeForDeploy } from "../../lib/compose/validate-for-deploy.ts";
import type { ComposeDocument } from "../../lib/compose/types.ts";

// Isolated in its own file, same reasoning as
// `src/daemon/acme-issuance-event.workers-e2e.test.ts`: a real-Postgres test
// alongside a large file of mocked-Db tests was observed to be flaky there.
//
// `sec-compose-privileged-gate` (Road-to-0.1.x artifact) was left unticked
// for: "no real converge or live route call against a real org row was run
// in this environment." This proves the route half — a real HTTP request,
// through the real session-cookie auth middleware and the real DB-backed
// `can()` authorization query, landing on a real `organization` row — then
// carries that same real row through `resolveComposeGatedFieldsEnabled` and
// `validateComposeForDeploy`, the exact two calls the production deploy
// callers (`planEnvironmentDeploy`, `deploy-prepare.ts`) make, to show the
// opt-in a real operator sets through this route actually changes what a
// real deploy would do with it.
describe("compose-privileged-fields real-Postgres end-to-end", () => {
  it(
    "PUT persists to a real org row through real session auth, and the real row then drives a real deploy-time decision",
    async () => {
      if (!env.HYPERDRIVE) {
        console.warn(
          "skipping real-Postgres compose-privileged-fields test: no HYPERDRIVE binding",
        );
        return;
      }
      const realDb = createWorkersDb(env.HYPERDRIVE);
      try {
        const secrets = await deriveSecretsConfig(
          parseSecretsEnv(testSecretsEnvLine(), "workers"),
          "session-signing",
        );

        const [org] = await realDb
          .insert(organization)
          .values({ name: "compose-gate-e2e-org" })
          .returning({ id: organization.id });
        const [owner] = await realDb
          .insert(user)
          // Unique per run: this file never deletes its rows (throwaway-database
          // convention), and `user.email` is unique, so a fixed address fails on
          // the second run against the same database.
          .values({
            email: `owner-${
              crypto.randomUUID().slice(0, 8)
            }@compose-gate-e2e.example.com`,
            role: "user",
          })
          .returning({ id: user.id });

        const token = crypto.randomUUID();
        await realDb.insert(sessionTable).values({
          token,
          userId: owner!.id,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        // Real DB-backed authorization, not a role bypass: an explicit
        // `organization:own` grant, the exact permission
        // `assertOrgOwnerOr403` requires — an `organization:manage` grant is
        // deliberately not sufficient for this route.
        await realDb.insert(grant).values({
          actorType: "user",
          actorId: owner!.id,
          entityType: "organization",
          entityId: org!.id,
          permission: "organization:own",
        });

        const app = new Hono<AppEnv>();
        app.use("*", async (c, next) => {
          c.set("db", realDb);
          await next();
        });
        registerOrganizationRoutes(app, { secrets });

        const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
          token,
          secrets,
        )}`;

        const getBefore = await app.request(
          `/organizations/${org!.id}/compose-privileged-fields`,
          { headers: { Cookie: cookie } },
        );
        expect(getBefore.status).toBe(200);
        expect(await getBefore.json()).toEqual({
          composeGatedFieldsEnabled: false,
        });

        const put = await app.request(
          `/organizations/${org!.id}/compose-privileged-fields`,
          {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ composeGatedFieldsEnabled: true }),
          },
        );
        expect(put.status).toBe(200);
        expect(await put.json()).toEqual({
          ok: true,
          composeGatedFieldsEnabled: true,
        });

        // Read the row back through an entirely separate connection, the way
        // a later deploy request would — not trusting the route's own response.
        const [row] = await realDb
          .select({ options: organization.options })
          .from(organization)
          .where(eq(organization.id, org!.id));
        const options = parseOrganizationOptions(row?.options);
        expect(resolveComposeGatedFieldsEnabled(options)).toBe(true);

        const privilegedDoc: ComposeDocument = {
          version: 1,
          data: {
            services: { web: { image: "nginx:alpine", privileged: true } },
          },
          presentation: { keyOrder: ["services"], comments: {} },
        };
        expect(
          validateComposeForDeploy(privilegedDoc, {
            composeGatedFieldsEnabled: resolveComposeGatedFieldsEnabled(
              options,
            ),
          }),
        ).toBe(null);

        // Flip it back off through the same real route and confirm the real
        // row now drives the deploy-time refusal too — the opt-in is a live
        // toggle, not a one-way ratchet.
        const putOff = await app.request(
          `/organizations/${org!.id}/compose-privileged-fields`,
          {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ composeGatedFieldsEnabled: false }),
          },
        );
        expect(putOff.status).toBe(200);

        const [rowAfter] = await realDb
          .select({ options: organization.options })
          .from(organization)
          .where(eq(organization.id, org!.id));
        const optionsAfter = parseOrganizationOptions(rowAfter?.options);
        expect(resolveComposeGatedFieldsEnabled(optionsAfter)).toBe(false);
        expect(
          validateComposeForDeploy(privilegedDoc, {
            composeGatedFieldsEnabled: resolveComposeGatedFieldsEnabled(
              optionsAfter,
            ),
          })?.kind,
        ).toBe("compose_field_requires_org_opt_in");
      } finally {
        await endDbConnection(realDb);
      }
    },
    20_000,
  );
});
