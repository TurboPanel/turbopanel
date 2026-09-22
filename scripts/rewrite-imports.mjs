#!/usr/bin/env node
/**
 * Mechanical move tool for the src/ reorg.
 *
 * Given an old→new map, `git mv`s files/dirs then rewrites relative
 * specifiers (`from`, `import()`, `new URL()`) from the *old* location to
 * the *new* one. A second pass replaces path-pinned strings in scripts,
 * configs, allow-lists, and docs (longest-first).
 *
 * Usage:
 *   node scripts/rewrite-imports.mjs --map scripts/reorg-maps/phase-1.json
 *   node scripts/rewrite-imports.mjs --root ../turbopaneld --map maps/phase-5.json
 *   node scripts/rewrite-imports.mjs --map map.json --dry-run
 *
 * Map JSON:
 *   { "files": { "src/old.ts": "src/new.ts" }, "dirs": { "src/old/": "src/new/" } }
 *
 * Idempotent: sources already at the destination are skipped; specifier
 * rewrite still runs using the recorded old path when a move happened this
 * invocation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function parseArgs(argv) {
  const out = { dryRun: false, root: process.cwd(), map: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--root') out.root = path.resolve(argv[++i] ?? '')
    else if (arg === '--map') out.map = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function fromPosix(p) {
  return p.split('/').join(path.sep)
}

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.turbo',
  '.local',
  '.cache',
  'coverage-apply-src',
  'coverage-commands',
  'coverage-deploy',
  'coverage-host-metrics',
  'coverage-instance',
  'coverage-lenient',
  'coverage-managed',
  'coverage-orch',
  'coverage-rest',
])

const PIN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
  '.properties',
  '.allowlist',
  '.j2',
  '.txt',
])

const SPECIFIER_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])

function isWordChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') || ch === '_'
}

function skipWs(text, i) {
  let next = i
  while (next < text.length) {
    const ch = text[next]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      next += 1
      continue
    }
    break
  }
  return next
}

function readQuotedSpec(text, i) {
  const quote = text[i]
  if (quote !== "'" && quote !== '"') return null
  const end = text.indexOf(quote, i + 1)
  if (end === -1) return null
  return { quote, spec: text.slice(i + 1, end), end }
}

function specifierStartAfter(content, keyword, idx) {
  let j = skipWs(content, idx + keyword.length)
  if (keyword === 'new') {
    if (!content.startsWith('URL', j)) return -1
    j = skipWs(content, j + 3)
    if (content[j] !== '(') return -1
    return skipWs(content, j + 1)
  }
  if (content[j] === '(') return skipWs(content, j + 1)
  return j
}

function nextKeywordIndex(content, from) {
  const fromIdx = content.indexOf('from', from)
  const importIdx = content.indexOf('import', from)
  const newIdx = content.indexOf('new', from)
  let best = -1
  let keyword = ''
  if (fromIdx !== -1) {
    best = fromIdx
    keyword = 'from'
  }
  if (importIdx !== -1 && (best === -1 || importIdx < best)) {
    best = importIdx
    keyword = 'import'
  }
  if (newIdx !== -1 && (best === -1 || newIdx < best)) {
    best = newIdx
    keyword = 'new'
  }
  if (best === -1) return null
  const before = best === 0 ? '' : content[best - 1]
  return { idx: best, keyword, skip: Boolean(before && isWordChar(before)) }
}

function rewriteKeywordHit(content, hit, oldDir, newDir, fileMap, root) {
  const keyLen = hit.keyword.length
  if (hit.skip) {
    return { text: content.slice(hit.idx, hit.idx + keyLen), next: hit.idx + keyLen }
  }
  const specAt = specifierStartAfter(content, hit.keyword, hit.idx)
  if (specAt < 0) {
    return { text: content.slice(hit.idx, hit.idx + keyLen), next: hit.idx + keyLen }
  }
  const quoted = readQuotedSpec(content, specAt)
  if (!quoted) {
    return { text: content.slice(hit.idx, specAt), next: specAt }
  }
  const spec = quoted.spec
  const prefix = content.slice(hit.idx, specAt + 1)
  let nextSpec = spec
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const mapped = resolveMappedTarget(oldDir, spec, fileMap, root)
    const restyled = restyleSpecifier(spec, mapped)
    nextSpec = posixRelative(newDir, restyled)
  }
  return { text: prefix + nextSpec + quoted.quote, next: quoted.end + 1 }
}

function walkFiles(dir, root, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      walkFiles(abs, root, out)
    } else if (entry.isFile()) {
      out.push(abs)
    }
  }
  return out
}

function loadMap(mapPath) {
  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
  const files = { ...(raw.files ?? {}) }
  const dirs = { ...(raw.dirs ?? {}) }
  return { files, dirs }
}

function stripTrailingSlashes(value) {
  let next = value
  while (next.endsWith('/')) next = next.slice(0, -1)
  return next
}

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function normalizeRel(rel) {
  return stripTrailingSlashes(toPosix(rel))
}

function expandDirMap(root, dirs) {
  /** @type {Record<string, string>} */
  const expanded = {}
  for (const [fromRaw, toRaw] of Object.entries(dirs)) {
    const from = normalizeRel(fromRaw)
    const to = normalizeRel(toRaw)
    const fromAbs = path.join(root, fromPosix(from))
    if (!fs.existsSync(fromAbs)) continue
    const nested = walkFiles(fromAbs, root)
    for (const abs of nested) {
      const rel = toPosix(path.relative(root, abs))
      const rest = rel.slice(from.length)
      const suffix = rest.startsWith('/') ? rest.slice(1) : rest
      expanded[rel] = suffix ? `${to}/${suffix}` : to
    }
  }
  return expanded
}

function buildFileMap(root, spec) {
  /** @type {Record<string, string>} */
  const fileMap = {}
  const dirExpanded = expandDirMap(root, spec.dirs)
  for (const [from, to] of Object.entries(dirExpanded)) {
    fileMap[normalizeRel(from)] = normalizeRel(to)
  }
  for (const [fromRaw, toRaw] of Object.entries(spec.files)) {
    fileMap[normalizeRel(fromRaw)] = normalizeRel(toRaw)
  }
  return fileMap
}

function dirMoves(spec) {
  return Object.entries(spec.dirs).map(([from, to]) => [
    normalizeRel(from),
    normalizeRel(to),
  ])
}

function isUnder(child, parent) {
  const c = normalizeRel(child)
  const p = normalizeRel(parent)
  return c === p || c.startsWith(`${p}/`)
}

function gitMv(root, fromRel, toRel, dryRun) {
  const fromAbs = path.join(root, fromPosix(fromRel))
  const toAbs = path.join(root, fromPosix(toRel))
  if (!fs.existsSync(fromAbs)) {
    if (fs.existsSync(toAbs)) return 'already'
    throw new Error(`git mv source missing: ${fromRel}`)
  }
  if (dryRun) {
    console.log(`git mv ${fromRel} ${toRel}`)
    return 'dry-run'
  }
  fs.mkdirSync(path.dirname(toAbs), { recursive: true })
  const result = spawnSync('/usr/bin/git', ['mv', '--', fromRel, toRel], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `git mv ${fromRel} → ${toRel} failed: ${result.stderr || result.stdout}`,
    )
  }
  return 'moved'
}

function posixRelative(fromDir, toFile) {
  let rel = toPosix(path.relative(fromPosix(fromDir), fromPosix(toFile)))
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

function stripKnownExt(rel) {
  if (rel.endsWith('.ts')) return rel.slice(0, -3)
  if (rel.endsWith('.tsx')) return rel.slice(0, -4)
  if (rel.endsWith('.mjs')) return rel.slice(0, -4)
  if (rel.endsWith('.js')) return rel.slice(0, -3)
  return rel
}

function candidateRels(fromDir, spec) {
  const joined = toPosix(path.normalize(path.join(fromPosix(fromDir), fromPosix(spec))))
  const cleaned = stripTrailingSlash(joined)
  const out = [cleaned]
  if (!path.extname(cleaned)) {
    out.push(
      `${cleaned}.ts`,
      `${cleaned}.tsx`,
      `${cleaned}.mjs`,
      `${cleaned}.js`,
      `${cleaned}/index.ts`,
    )
  }
  return out
}

function resolveMappedTarget(fromOldDir, spec, fileMap, root) {
  const destByOld = fileMap
  const oldByNew = new Map(Object.entries(fileMap).map(([oldRel, newRel]) => [newRel, oldRel]))
  for (const rel of candidateRels(fromOldDir, spec)) {
    const normalized = normalizeRel(rel)
    if (destByOld[normalized]) return destByOld[normalized]
    if (oldByNew.has(normalized)) return normalized
    if (fs.existsSync(path.join(root, fromPosix(normalized)))) return normalized
  }
  return normalizeRel(candidateRels(fromOldDir, spec)[0])
}

function restyleSpecifier(originalSpec, newTargetRel) {
  const hadTrailingSlash = originalSpec.endsWith('/')
  let next = newTargetRel
  const origExt = path.posix.extname(stripTrailingSlash(originalSpec))
  const targetExt = path.posix.extname(next)
  if (!origExt && targetExt) {
    next = stripKnownExt(next)
  }
  if (hadTrailingSlash && !next.endsWith('/')) next = `${next}/`
  return next
}

function rewriteSpecifiers(content, oldRel, newRel, fileMap, root) {
  const oldDir = path.posix.dirname(oldRel)
  const newDir = path.posix.dirname(newRel)
  let out = ''
  let i = 0
  while (i < content.length) {
    const hit = nextKeywordIndex(content, i)
    if (!hit) {
      out += content.slice(i)
      break
    }
    out += content.slice(i, hit.idx)
    const piece = rewriteKeywordHit(content, hit, oldDir, newDir, fileMap, root)
    out += piece.text
    i = piece.next
  }
  return out
}

function longestFirstMappings(fileMap) {
  return Object.entries(fileMap).sort((a, b) => b[0].length - a[0].length)
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`)
}

function replacePathTokens(content, mappings) {
  let next = content
  for (const [from, to] of mappings) {
    if (from === to) continue
    next = next.replaceAll(new RegExp(escapeRegExp(from), 'g'), to)
  }
  return next
}

function isPinFile(abs, root) {
  const rel = toPosix(path.relative(root, abs))
  const ext = path.extname(abs)
  if (rel.startsWith('node_modules/') || rel.startsWith('dist/')) return false
  if (rel.startsWith('scripts/reorg-maps/')) return false
  if (rel.endsWith('pnpm-lock.yaml') || rel.endsWith('deno.lock')) return false
  if (PIN_EXTENSIONS.has(ext)) return true
  const base = path.basename(abs)
  return base === '.secretscan-allowlist' || base === '.gitignore'
}

function applyGitMoves(root, spec, fileMap, dryRun) {
  const movedThisRun = new Map()
  const dirPairs = dirMoves(spec).sort((a, b) => b[0].length - a[0].length)
  const movedDirs = []
  for (const [from, to] of dirPairs) {
    const fromAbs = path.join(root, fromPosix(from))
    if (!fs.existsSync(fromAbs)) {
      if (fs.existsSync(path.join(root, fromPosix(to)))) continue
      console.warn(`rewrite-imports: dir missing, skip ${from}`)
      continue
    }
    const status = gitMv(root, from, to, dryRun)
    if (status === 'moved' || status === 'dry-run') movedDirs.push(from)
  }

  const filePairs = Object.entries(fileMap).sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of filePairs) {
    if (movedDirs.some((dir) => isUnder(from, dir))) {
      movedThisRun.set(to, from)
      continue
    }
    const status = gitMv(root, from, to, dryRun)
    if (status === 'moved' || status === 'dry-run') movedThisRun.set(to, from)
  }
  return movedThisRun
}

function rewriteTree(root, fileMap, movedThisRun) {
  const mappings = longestFirstMappings(fileMap)
  const allFiles = walkFiles(root, root)
  let specCount = 0
  let pinCount = 0
  for (const abs of allFiles) {
    const rel = toPosix(path.relative(root, abs))
    const ext = path.extname(abs)
    let text = fs.readFileSync(abs, 'utf8')
    const original = text
    if (SPECIFIER_EXTENSIONS.has(ext)) {
      const oldRel = movedThisRun.get(rel) ?? rel
      text = rewriteSpecifiers(text, oldRel, rel, fileMap, root)
    }
    if (isPinFile(abs, root)) {
      text = replacePathTokens(text, mappings)
    }
    if (text !== original) {
      fs.writeFileSync(abs, text)
      if (SPECIFIER_EXTENSIONS.has(ext)) specCount += 1
      else pinCount += 1
    }
  }
  return { specCount, pinCount }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.map) {
    console.log(
      'Usage: node scripts/rewrite-imports.mjs --map <map.json> [--root <dir>] [--dry-run]',
    )
    process.exit(args.help ? 0 : 2)
  }
  const root = args.root
  const mapPath = path.isAbsolute(args.map)
    ? args.map
    : path.resolve(process.cwd(), args.map)
  const spec = loadMap(mapPath)
  const fileMap = buildFileMap(root, spec)
  if (Object.keys(fileMap).length === 0) {
    console.error('rewrite-imports: map produced no file moves')
    process.exit(1)
  }

  const movedThisRun = applyGitMoves(root, spec, fileMap, args.dryRun)
  if (args.dryRun) {
    console.log(`dry-run: ${movedThisRun.size} mapped files`)
    return
  }

  const { specCount, pinCount } = rewriteTree(root, fileMap, movedThisRun)
  console.log(
    `rewrite-imports: moved ${movedThisRun.size} files, rewrote ${specCount} specifier files, ${pinCount} pin files`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
