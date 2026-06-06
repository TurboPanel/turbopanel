#!/usr/bin/env node
/**
 * Update DEV_MODE in the root .env without overwriting unrelated keys.
 * Used by Tilt UI buttons to request hot-swapping via the wrapper.
 *
 * Usage: node scripts/set-dev-mode.mjs <mode>
 * Example: node scripts/set-dev-mode.mjs workers
 *          node scripts/set-dev-mode.mjs deno
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VALID_MODES = ['deno', 'workers']

const argv = process.argv.slice(2)

if (argv.length !== 1) {
  console.error('Error: Expected exactly one argument (mode)')
  console.error('Usage: node scripts/set-dev-mode.mjs <mode>')
  console.error('  mode: "deno" or "workers"')
  process.exit(1)
}

const mode = argv[0]

if (!VALID_MODES.includes(mode)) {
  console.error(`Error: Invalid mode "${mode}"`)
  console.error('  Valid modes: "deno" or "workers"')
  process.exit(1)
}

const envFile = join(import.meta.dirname, '..', '.env')

try {
  let envContent = ''
  try {
    envContent = readFileSync(envFile, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }

  const lines = envContent.split('\n')
  let modeLineFound = false
  const updatedLines = lines.map((line) => {
    if (line.trim().startsWith('DEV_MODE=')) {
      modeLineFound = true
      return `DEV_MODE=${mode}`
    }
    return line
  })

  if (!modeLineFound) {
    updatedLines.unshift(`DEV_MODE=${mode}`)
  }

  writeFileSync(envFile, updatedLines.join('\n'), 'utf8')
  process.exit(0)
} catch (err) {
  console.error(`Error updating .env file: ${err.message}`)
  process.exit(1)
}
