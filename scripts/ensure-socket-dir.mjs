#!/usr/bin/env node
/**
 * Ensure /run/turbopanel exists with turbopanel ownership for Unix socket backends.
 *
 * Uses passwordless sudo when the directory is missing or has wrong owner/mode.
 * Prints TURBOPANEL_SOCKET and TURBOPANEL_SOCKET_DIAL for dev env wiring.
 *
 * Mode is 2770 (group-writable + setgid): both the daemon (turbopanel) and the
 * in-group `instance` user bind sockets here, and setgid keeps new socket files
 * in the turbopanel group so the other party can connect.
 */

import { execSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'

const SOCKET_DIR = (process.env.TURBOPANEL_SOCKET_DIR ?? '/run/turbopanel').replace(/\/$/, '')
const SOCKET_NAME = 'instance.sock'
const SOCKET_PATH = `${SOCKET_DIR}/${SOCKET_NAME}`
const SOCKET_DIAL = SOCKET_PATH.replace(/^\/+/, '')
const OWNER = 'turbopanel'
const MODE = 0o2770

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' })
}

function sudo(cmd) {
  run(`sudo ${cmd}`)
}

async function dirLooksCorrect() {
  try {
    const info = await stat(SOCKET_DIR)
    if (!info.isDirectory()) return false
    if ((info.mode & 0o7777) !== MODE) return false

    const owner = execSync(`stat -c '%U:%G' '${SOCKET_DIR}'`, { encoding: 'utf8' }).trim()
    return owner === `${OWNER}:${OWNER}`
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
      run(`chown ${OWNER}:${OWNER} '${SOCKET_DIR}'`)
      run(`chmod ${MODE.toString(8)} '${SOCKET_DIR}'`)
    } else {
      try {
        execSync('sudo -n true', { stdio: 'ignore' })
      } catch {
        console.error(
          `[ensure-socket-dir] ${SOCKET_DIR} is missing or misconfigured and passwordless sudo is unavailable.`,
        )
        console.error('[ensure-socket-dir] Run the daemon socket-dirs-setup playbook or fix permissions manually.')
        process.exit(1)
      }

      sudo(`mkdir -p '${SOCKET_DIR}'`)
      sudo(`chown ${OWNER}:${OWNER} '${SOCKET_DIR}'`)
      sudo(`chmod ${MODE.toString(8)} '${SOCKET_DIR}'`)
    }
  }

  console.log(`TURBOPANEL_SOCKET=${SOCKET_PATH}`)
  console.log(`TURBOPANEL_SOCKET_DIAL=${SOCKET_DIAL}`)
}

main().catch((err) => {
  console.error('[ensure-socket-dir]', err instanceof Error ? err.message : err)
  process.exit(1)
})
