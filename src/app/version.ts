import denoConfig from '../../deno.json' with { type: 'json' }

/**
 * The instance's semver, read from deno.json at build time — the one place
 * the number is typed for this repo (package.json mirrors it; version.test.ts
 * pins the two, and sonar.projectVersion, together). Everything that puts a
 * version on a wire reads it from here: the three OpenAPI documents'
 * info.version, /api/health, and the x-turbopanel-version response header
 * the app compares against its supported range.
 *
 * Workers and Deno both import this module — a JSON import, no Deno APIs.
 */
export const INSTANCE_VERSION: string = denoConfig.version
