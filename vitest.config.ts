import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { applyWranglerHyperdriveLocalEnv } from './scripts/resolve-wrangler-hyperdrive-env.mjs'

applyWranglerHyperdriveLocalEnv()

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.vitest.jsonc' },
      main: './src/workers-vitest.ts',
      miniflare: {
        isolatedStorage: false,
        bindings: {
          TURBOPANEL_SECRETS: '1:aa_daemon_cell_vitest_secret_value_aaaa_b_pad_abcdefghij0',
          // Construct-time DO binding — runtime `env.TURBOPANEL_DAEMON_DEBUG = …`
          // in tests does not update the Durable Object's env snapshot.
          TURBOPANEL_DAEMON_DEBUG: '1',
          // Same construct-time pattern for inbound flood-cap tests.
          TURBOPANEL_DAEMON_WS_INBOUND_LIMIT: '120',
          TURBOPANEL_DAEMON_WS_INBOUND_WINDOW_MS: '60000',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@turbopanel/email/smtp-sender': path.resolve(
        rootDir,
        './src/features/email/smtp/smtp-sender-shim.ts'
      ),
    },
  },
  test: {
    include: [
      'src/**/*.workers.test.ts',
      'src/**/*.workers-e2e.test.ts',
      'src/**/*.entry.test.ts',
    ],
    coverage: {
      // Istanbul instruments source at build time, so — unlike the default
      // `v8` provider — it works inside workerd (no `node:inspector`). This
      // pool bridges the instrumented counters back out to the Node.js
      // process via a loopback request after each test file finishes, so a
      // plain `lcov` reporter here is a real, non-zero report. Left disabled
      // by default (no `enabled: true`) so `pnpm test:do` stays fast; `pnpm
      // test:coverage` (scripts/test-coverage.sh) turns it on with `--coverage`.
      provider: 'istanbul',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage/vitest',
      // Coverage attribution: suffix globs above. Name a new Workers/DO
      // suite `*.workers.test.ts` (or `*.workers-e2e.test.ts` / `*.entry.test.ts`)
      // so it is included here and ignored by the Deno inventory.
    },
  },
})
