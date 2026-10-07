import { collectComposeInterpolationKeys } from './variable-refs.ts'

/** Variable names a generated `.env` file defines (`KEY=value` lines). */
function envFileKeys(envFile: string): Set<string> {
  const keys = new Set<string>()
  for (const line of envFile.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0 && !line.startsWith('#')) keys.add(line.slice(0, eq).trim())
  }
  return keys
}

/**
 * Compose `${NAME}` references in the compiled YAML that nothing defines.
 *
 * Panel variables are only substituted through `{$NAME}`; a plain `${NAME}`
 * is left for Docker Compose, which reads the generated `.env`, so it turns
 * into an empty string (and a Compose warning nobody sees) unless that file
 * happens to define `NAME`. `$$` is an escaped literal dollar and is skipped.
 */
export function findUnresolvedComposeInterpolations(
  composeYaml: string,
  envFile: string
): string[] {
  const defined = envFileKeys(envFile)
  return collectComposeInterpolationKeys(composeYaml.replaceAll('$$', '')).filter(
    (key) => !defined.has(key)
  )
}
