/**
 * Where a catalog entry's compose lives on a new project.
 *
 * A new project's content goes into its environments' own compose changes and
 * the Base starts empty. A catalog entry still declares a shared compose plus a
 * per-environment one; the environment gets the two merged by the same rule a
 * deploy uses, so the deploy sees exactly what it saw when the shared part sat
 * in the Base.
 */
import {
  emptyComposeDocument,
  isBlankComposeData,
  mergeComposeLayers,
  type ComposeDocument,
} from '../../features/compose/index.ts'
import type { CatalogEntry, CatalogEnvironment } from './catalog/index.ts'

export function catalogEnvironmentCompose(
  entry: Pick<CatalogEntry, 'compose'>,
  env: Pick<CatalogEnvironment, 'compose'> | undefined
): ComposeDocument | null {
  const layers = [
    { role: 'project' as const, filename: 'docker-compose.yml', document: entry.compose },
    ...(env?.compose
      ? [
          {
            role: 'environment' as const,
            filename: 'docker-compose.environment.yml',
            document: env.compose,
          },
        ]
      : []),
  ]
  const merged = mergeComposeLayers(layers)
  return isBlankComposeData(merged.data) ? null : merged
}

/** The Base a new project starts with: nothing. */
export function emptyBaseCompose(): ComposeDocument {
  return emptyComposeDocument()
}
