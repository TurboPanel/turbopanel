export const QUERY_CACHE_PREFIX = 'tp:qcache:'

export function queryCacheKey(namespace: string, ...parts: string[]): string {
  return [QUERY_CACHE_PREFIX + namespace, ...parts].join(':')
}
