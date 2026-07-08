import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineWorkersConfig({
  wrangler: {
    configPath: './wrangler.vitest.jsonc',
  },
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
      'src/lib/settings/email-settings.test.ts',
      'src/client/authn/install-state.test.ts',
      'src/client/authn/data-encryption.test.ts',
      'mailer/rate-limiter.test.ts',
    ],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.vitest.jsonc',
        },
        main: './src/workers-vitest.ts',
        isolatedStorage: false,
        miniflare: {
          bindings: {
            TURBOPANEL_SECRET: 'aa_daemon_cell_vitest_secret_value_aaaa_b',
            // Construct-time DO binding — runtime `env.TURBOPANEL_DAEMON_DEBUG = …`
            // in tests does not update the Durable Object's env snapshot.
            TURBOPANEL_DAEMON_DEBUG: '1',
          },
        },
      },
    },
  },
})
