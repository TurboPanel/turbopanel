import { HYPERDRIVE_CACHED_PLACEHOLDER_ID } from './workers-bindings.ts'

const HYPERDRIVE_CACHED_BINDING = '"binding": "HYPERDRIVE_CACHED"'

/** Strip // line comments so JSONC can be parsed for binding checks. */
export function stripJsoncLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function extractHyperdriveCachedId(block: string): string | undefined {
  const bindingIndex = block.indexOf(HYPERDRIVE_CACHED_BINDING)
  if (bindingIndex < 0) return undefined
  const tail = block.slice(bindingIndex)
  const match = /"id"\s*:\s*"([^"]+)"/.exec(tail)
  return match?.[1]
}

export function readHyperdriveCachedIdsFromWranglerJsonc(
  wranglerText: string,
): { topLevel?: string; testing?: string; live?: string } {
  const text = stripJsoncLineComments(wranglerText)
  const topLevelEnd = text.indexOf('"env"')
  const topLevelBlock = topLevelEnd < 0 ? text : text.slice(0, topLevelEnd)
  const testingMatch = /"testing"\s*:\s*\{/.exec(text)
  const liveMatch = /"live"\s*:\s*\{/.exec(text)
  const testingBlock = testingMatch
    ? text.slice(
      testingMatch.index,
      liveMatch?.index ?? text.length,
    )
    : ''
  const liveBlock = liveMatch ? text.slice(liveMatch.index) : ''

  return {
    topLevel: extractHyperdriveCachedId(topLevelBlock),
    testing: extractHyperdriveCachedId(testingBlock),
    live: extractHyperdriveCachedId(liveBlock),
  }
}

export function assertExercisedHyperdriveCachedBindings(
  ids: { testing?: string; live?: string },
): void {
  for (const [envName, id] of Object.entries(ids) as Array<
    ['testing' | 'live', string | undefined]
  >) {
    if (!id || id === HYPERDRIVE_CACHED_PLACEHOLDER_ID) {
      throw new Error(
        `${envName} HYPERDRIVE_CACHED must use a real Hyperdrive config id (not ${HYPERDRIVE_CACHED_PLACEHOLDER_ID})`,
      )
    }
  }
}
