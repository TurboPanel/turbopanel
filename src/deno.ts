import { createApp } from './app.ts'

const app = createApp()

Deno.serve({ port: 8787 }, app.fetch)
