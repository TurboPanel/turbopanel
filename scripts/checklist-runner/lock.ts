/**
 * One run at a time. The lock is a file created with `createNew`, so two
 * runners racing for it cannot both win. A lock left by a crashed run is
 * never stolen silently: the error names the file and the pid inside it.
 */

export interface LockFs {
  createNew(path: string, content: string): Promise<void>
  readText(path: string): Promise<string>
  remove(path: string): Promise<void>
}

export const denoLockFs: LockFs = {
  async createNew(path, content) {
    const file = await Deno.open(path, { write: true, createNew: true, mode: 0o600 })
    try {
      await file.write(new TextEncoder().encode(content))
    } finally {
      file.close()
    }
  },
  readText: (path) => Deno.readTextFile(path),
  remove: (path) => Deno.remove(path),
}

export class LockHeldError extends Error {
  override name = 'LockHeldError'
}

export interface Lock {
  path: string
  release(): Promise<void>
}

export async function acquireLock(
  path: string,
  fs: LockFs = denoLockFs,
  now: () => Date = () => new Date()
): Promise<Lock> {
  const content = JSON.stringify({ pid: Deno.pid, startedAt: now().toISOString() })
  try {
    await fs.createNew(path, content)
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error
    const holder = await fs.readText(path).catch(() => '(unreadable)')
    throw new LockHeldError(
      `another checklist run holds ${path} (${holder.trim()}). ` +
        'If that run is gone, confirm no runner process is alive, then delete the file.'
    )
  }
  let released = false
  return {
    path,
    async release() {
      if (released) return
      released = true
      await fs.remove(path).catch(() => undefined)
    },
  }
}
