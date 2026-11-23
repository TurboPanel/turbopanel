#!/usr/bin/env node
/**
 * Rewrites `src/app/api-error-baseline.ts` from the tree: per file, how many
 * hand-built error bodies (`c.json({ ... error ... })`, `{ ok: false }`, or the
 * same inside `new Response(JSON.stringify(...))`) remain.
 * Run it after moving routes onto `apiError`; the guard test fails until the
 * baseline matches, so the numbers only ever go down.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PATTERN =
  /\b(?:c\.json\(|new Response\(\s*JSON\.stringify\()\s*\{[^{}]*?\b(?:ok\s*:\s*false|error\s*[:,}])/g

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

const counts = {}
for (const file of walk('src', []).sort()) {
  const n = (readFileSync(file, 'utf8').match(PATTERN) ?? []).length
  if (n > 0) counts[file] = n
}
const rows = Object.entries(counts)
  .map(([file, n]) => `  '${file}': ${n},`)
  .join('\n')
writeFileSync(
  'src/app/api-error-baseline.ts',
  `/**
 * Hand-built error bodies still outside \`apiError\` (\`src/lib/http/api-error.ts\`),
 * per file. A ratchet: \`api-error-guard.hostfree.test.ts\` fails when a file
 * has more than its row (new hand-built errors), or fewer (lower the row).
 * Regenerate with \`node scripts/gen-api-error-baseline.mjs\`.
 */
export const HAND_BUILT_ERROR_BASELINE: Record<string, number> = {
${rows}
}
`
)
console.log(
  `${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} bodies`
)
