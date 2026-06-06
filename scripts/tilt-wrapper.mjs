#!/usr/bin/env node
/**
 * TurboPanel Tilt Wrapper - Enables hot-swapping between Deno and Workers modes
 *
 * Usage: node scripts/tilt-wrapper.mjs [deno|workers]
 *
 * Spawns Tilt as a child process and monitors .env for DEV_MODE changes.
 * When a mode switch is requested, gracefully kills current Tilt and restarts with new mode.
 */

import { spawn, execSync } from 'node:child_process'
import { watch, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const ANSI = {
  blue: '\x1b[34m',
  blueBright: '\x1b[94m',
  yellow: '\x1b[33m',
  yellowBright: '\x1b[93m',
  green: '\x1b[32m',
  greenBright: '\x1b[92m',
  magenta: '\x1b[35m',
  magentaBright: '\x1b[95m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  whiteBright: '\x1b[97m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
}

function colorize(text, colorName) {
  const code = ANSI[colorName] || ANSI.reset
  return `${code}${text}${ANSI.reset}`
}

function printModeBanner(mode) {
  const label = mode === 'workers' ? 'WORKERS MODE' : 'DENO MODE'
  const labelColor = mode === 'workers' ? 'yellow' : 'greenBright'
  console.log('')
  console.log(colorize(`  ${label}  `, labelColor))
  console.log('')
  console.log(colorize(`   Watching ${ENV_FILE} for mode changes`, 'yellow'))
  console.log('')
}

// Constants
const ENV_FILE = path.join(process.cwd(), '.env')
const DEBOUNCE_MS = 100

/**
 * Reads DEV_MODE value from .env file
 * @returns {string|null} Mode value ('deno' or 'workers') or null if not found/invalid
 */
function readModeFromEnv() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8')
    const match = envContent.match(/^DEV_MODE=(.+)$/m)
    if (match) {
      const mode = match[1].trim()
      if (mode === 'deno' || mode === 'workers') {
        return mode
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(colorize(`⚠️  Error reading .env file: ${err.message}`, 'yellow'))
    }
  }
  return null
}

// Parse command-line arguments
const argv = process.argv.slice(2)
const command = argv[0]

let currentMode = command

// If no command-line argument, try to read from .env
if (!currentMode) {
  currentMode = readModeFromEnv() || 'deno'
}

// Validate mode
if (currentMode !== 'deno' && currentMode !== 'workers') {
  console.error(
    colorize(`❌ Invalid mode: ${currentMode}. Must be 'deno' or 'workers'.`, 'red')
  )
  process.exit(1)
}

// Module-level variables
let currentTiltProcess = null
let isHotSwapping = false
let isShuttingDown = false
let debounceTimer = null

/**
 * Attaches exit and error handlers to a Tilt child process
 */
function attachTiltHandlers(child) {
  child.on('exit', (code, signal) => {
    if (isShuttingDown) {
      // Expected shutdown
      process.exit(code ?? 0)
    } else if (isHotSwapping) {
      // Expected exit during hot-swap, new process already spawned
      return
    } else {
      // Unexpected exit
      console.error(colorize(`❌ Tilt exited unexpectedly with code ${code}`, 'red'))
      process.exit(code ?? 1)
    }
  })

  child.on('error', (err) => {
    console.error(colorize(`❌ Failed to start Tilt: ${err.message}`, 'red'))
    console.error(colorize(`   Make sure Tilt is installed and in your PATH`, 'red'))
    process.exit(1)
  })
}

/**
 * Spawns a Tilt process for the specified mode.
 * Always passes a positional mode arg so behavior does not depend on the root Tiltfile default.
 */
function spawnTilt(mode) {
  const args = ['up']
  if (mode === 'deno') {
    args.push('deno')
  } else if (mode === 'workers') {
    args.push('workers')
  }

  const child = spawn('tilt', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, TILT_WRAPPER_ACTIVE: '1' },
  })

  currentTiltProcess = child
  attachTiltHandlers(child)
  return child
}

/**
 * Waits for a process to exit with timeout (resolves immediately if already exited).
 */
function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) {
      resolve(true)
      return
    }
    let resolved = false
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolve(false) // timeout
      }
    }, timeoutMs)

    proc.once('exit', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        resolve(true) // exited gracefully
      }
    })
  })
}

/**
 * Stops the current Tilt child: tilt down (Docker + local resources), then wait/kill if needed.
 */
async function stopCurrentTiltForModeSwitch() {
  if (!currentTiltProcess) {
    return
  }
  try {
    console.log(colorize('   Running tilt down to stop services...', 'yellow'))
    execSync(tiltDownCommandForMode(currentMode), {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, TILT_WRAPPER_ACTIVE: '1' },
    })
  } catch (err) {
    if (err.status !== undefined && err.status !== 0) {
      console.error(colorize(`   tilt down exited with code ${err.status}`, 'yellow'))
    }
  }
  if (currentTiltProcess.exitCode === null) {
    currentTiltProcess.kill('SIGTERM')
  }
  let exited = await waitForExit(currentTiltProcess, 5000)
  if (!exited && currentTiltProcess.exitCode === null) {
    console.log(colorize('⚠️  Tilt did not exit after tilt down, forcing shutdown...', 'yellow'))
    currentTiltProcess.kill('SIGKILL')
    exited = await waitForExit(currentTiltProcess, 3000)
  }
  if (!exited && currentTiltProcess.exitCode === null) {
    console.error(
      colorize('⚠️  Tilt child still running after forced kill; continuing mode switch', 'yellow')
    )
  }
}

/**
 * Switches to a new Tilt mode
 */
async function switchMode(newMode) {
  if (newMode === currentMode) {
    return
  }

  if (isHotSwapping || isShuttingDown) {
    return
  }

  isHotSwapping = true

  console.log(colorize(`🔄 Switching to ${newMode} mode...`, 'cyan'))

  await stopCurrentTiltForModeSwitch()

  // Update mode, show banner, then spawn new process (wait for old child first so exit handler does not fire after isHotSwapping is cleared)
  currentMode = newMode
  console.log(colorize(`✅ Switched to ${newMode} mode`, 'green'))
  printModeBanner(currentMode)
  spawnTilt(currentMode)
  isHotSwapping = false
}

/**
 * Handles .env file changes
 */
async function handleEnvFile() {
  try {
    const content = await readFile(ENV_FILE, 'utf-8')

    // Extract DEV_MODE value using regex
    const match = content.match(/^DEV_MODE=(.+)$/m)
    if (!match) {
      return
    }

    const requestedMode = match[1].trim()

    // Validate requested mode
    if (requestedMode !== 'deno' && requestedMode !== 'workers') {
      console.error(colorize(`❌ Invalid DEV_MODE in .env: ${requestedMode}`, 'red'))
      return
    }

    // Trigger switch if different from current mode
    if (requestedMode !== currentMode) {
      await switchMode(requestedMode)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(colorize(`❌ Error reading .env file: ${err.message}`, 'red'))
    }
  }
}

/**
 * Starts watching the .env file
 */
function startEnvFileWatcher() {
  let watcher

  try {
    watcher = watch(ENV_FILE, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        // Debounce rapid changes
        if (debounceTimer) {
          clearTimeout(debounceTimer)
        }
        debounceTimer = setTimeout(() => {
          handleEnvFile()
        }, DEBOUNCE_MS)
      }
    })

    watcher.on('error', (err) => {
      // Watcher errors are expected when file is deleted
      if (err.code !== 'ENOENT') {
        console.error(colorize(`⚠️  .env file watcher error: ${err.message}`, 'yellow'))
      }
      // Restart watcher after a delay
      setTimeout(startEnvFileWatcher, 1000)
    })
  } catch (err) {
    // File doesn't exist yet, that's okay
    if (err.code !== 'ENOENT') {
      console.error(colorize(`⚠️  Could not start .env file watcher: ${err.message}`, 'yellow'))
    }
    // Restart watcher after a delay
    setTimeout(startEnvFileWatcher, 1000)
  }

  return watcher
}

/**
 * @param {string} mode
 * @returns {string} tilt CLI invocation with Tiltfile positional args (so mode-specific teardown runs)
 */
function tiltDownCommandForMode(mode) {
  if (mode === 'workers') {
    return 'tilt down -- workers'
  }
  return 'tilt down -- deno'
}

/**
 * Handles graceful shutdown: runs tilt down to tear down resources, then exits.
 */
async function shutdown(signal) {
  if (isShuttingDown) {
    return
  }
  isShuttingDown = true

  console.log(colorize(`\n🛑 Received ${signal}, shutting down...`, 'yellow'))

  if (currentTiltProcess) {
    // Run tilt down so resources are torn down cleanly (pass Tiltfile args so docker-dev compose teardown runs)
    const tiltDownCmd = tiltDownCommandForMode(currentMode)
    try {
      console.log(colorize('   Running tilt down...', 'yellow'))
      execSync(tiltDownCmd, {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: { ...process.env, TILT_WRAPPER_ACTIVE: '1' },
      })
    } catch (err) {
      // tilt down may exit non-zero if already down or connection lost; still exit cleanly
      if (err.status !== undefined && err.status !== 0) {
        console.error(colorize(`   tilt down exited with code ${err.status}`, 'yellow'))
      }
    }
    // Ensure child is gone (tilt down usually stops the server and the tilt up process exits)
    if (currentTiltProcess.exitCode === null) {
      currentTiltProcess.kill('SIGTERM')
      await waitForExit(currentTiltProcess, 3000)
      if (currentTiltProcess.exitCode === null) {
        currentTiltProcess.kill('SIGKILL')
      }
    }
  }

  process.exit(0)
}

/**
 * Main execution
 */
async function main() {
  printModeBanner(currentMode)

  // Ensure no existing Tilt session is running before starting (mode-specific down runs Tiltfile teardown).
  for (const mode of ['deno', 'workers']) {
    try {
      execSync(tiltDownCommandForMode(mode), {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf-8',
      })
    } catch {
      // tilt down may exit non-zero if nothing was running; ignore
    }
  }
  console.log(colorize('   Cleared any existing Tilt session', 'yellow'))

  // Setup signal handlers
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Spawn initial Tilt process (handlers attached via spawnTilt)
  spawnTilt(currentMode)

  // Start .env file watcher
  startEnvFileWatcher()

  // Keep wrapper alive
  process.stdin.resume()
}

// Run main (top-level await — Node ESM)
try {
  await main()
} catch (err) {
  console.error(colorize(`❌ Fatal error: ${err.message}`, 'red'))
  console.error(err.stack)
  process.exit(1)
}
