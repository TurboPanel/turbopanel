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
          TURBOPANEL_SECRET:
            'aa_daemon_cell_vitest_secret_value_aaaa_b_pad_abcdefghij0',
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
        './src/lib/email/smtp/smtp-sender-shim.ts',
      ),
    },
  },
  test: {
    include: [
      'src/daemon/workers-ws.test.ts',
      'src/daemon/durable-object.test.ts',
      'src/developer/dev-sync-archive.test.ts',
      'src/lib/daemon-install-command.test.ts',
      'src/admin/public-urls.test.ts',
      'src/lib/settings/email-settings.test.ts',
      'src/client/authn/signup-validation.test.ts',
      'src/client/authn/data-encryption.test.ts',
      'src/client/authn/password.test.ts',
      'src/daemon/metrics/validation.test.ts',
      'mailer/rate-limiter.test.ts',
    ],
  },
})
