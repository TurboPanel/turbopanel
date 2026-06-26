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
      'src/daemon/durable-object.test.ts',
      'src/lib/daemon-install-command.test.ts',
      'src/lib/settings/email-settings.test.ts',
      'src/client/authn/install-state.test.ts',
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
          },
        },
      },
    },
  },
})
