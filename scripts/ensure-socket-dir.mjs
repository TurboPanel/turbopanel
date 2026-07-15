#!/usr/bin/env node
/**
 * Ensure /run/turbopanel exists with correct ownership for Unix socket backends.
 *
 * Uses passwordless sudo when the directory is missing or has wrong owner/mode.
 * Prints TURBOPANEL_SOCKET and TURBOPANEL_SOCKET_DIAL for dev env wiring.
 *
 * Mode is 2770 (group-writable + setgid): co-located dev collapses owner/group
 * onto the single dev user; managed installs use turbopanel:turbopanel so the
 * instance stack can bind sockets and share group access.
 */

import { execSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'

function resolveSocketDir() {
  const runDir = process.env.TURBOPANEL_RUN_DIR?.replace(/\/$/, '')
  const socketDir = process.env.TURBOPANEL_SOCKET_DIR?.replace(/\/$/, '')
  return runDir || socketDir || '/run/turbopanel'
}

const SOCKET_DIR = resolveSocketDir()
const SOCKET_NAME = 'instance.sock'
const SOCKET_PATH = `${SOCKET_DIR}/${SOCKET_NAME}`
const SOCKET_DIAL = SOCKET_PATH.replace(/^\/+/, '')
const OWNER =
  process.env.TURBOPANEL_SOCKET_OWNER?.trim() ||
  process.env.TURBOPANEL_DEV_USER?.trim() ||
  'turbopanel'
const GROUP =
  process.env.TURBOPANEL_SOCKET_GROUP?.trim() ||
  process.env.TURBOPANEL_DEV_USER?.trim() ||
  'turbopanel'
const MODE = 0o2770

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' })
}

function sudo(cmd) {
  run(`/usr/bin/sudo ${cmd}`)
}

async function dirLooksCorrect() {
  try {
    const info = await stat(SOCKET_DIR)
    if (!info.isDirectory()) return false
    if ((info.mode & 0o7777) !== MODE) return false

    const owner = execSync(`stat -c '%U:%G' '${SOCKET_DIR}'`, { encoding: 'utf8' }).trim()
    return owner === `${OWNER}:${GROUP}`
  } catch {
    return false
  }
}

async function canWriteWithoutSudo() {
  try {
    await access(SOCKET_DIR, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!(await dirLooksCorrect())) {
    if (await canWriteWithoutSudo()) {
      run(`mkdir -p '${SOCKET_DIR}'`)
      run(`chown ${OWNER}:${GROUP} '${SOCKET_DIR}'`)
      run(`chmod ${MODE.toString(8)} '${SOCKET_DIR}'`)
    } else {
      try {
        execSync('/usr/bin/sudo -n true', { stdio: 'ignore' })
      } catch {
        console.error(
          `[ensure-socket-dir] ${SOCKET_DIR} is missing or misconfigured and passwordless sudo is unavailable.`,
        )
        console.error('[ensure-socket-dir] Run the daemon socket-dirs-setup playbook or fix permissions manually.')
        process.exit(1)
      }

      sudo(`mkdir -p '${SOCKET_DIR}'`)
      sudo(`chown ${OWNER}:${GROUP} '${SOCKET_DIR}'`)
      sudo(`chmod ${MODE.toString(8)} '${SOCKET_DIR}'`)
    }
  }

  console.log(`TURBOPANEL_SOCKET=${SOCKET_PATH}`)
  console.log(`TURBOPANEL_SOCKET_DIAL=${SOCKET_DIAL}`)
}

try {
  await main()
} catch (err) {
  console.error('[ensure-socket-dir]', err instanceof Error ? err.message : err)
  process.exit(1)
}
