import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  wrangler: {
    configPath: './wrangler.vitest.jsonc',
  },
  test: {
    include: ['src/daemon/durable-object.test.ts'],
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
