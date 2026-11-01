import { createListenerProvider } from './listener.ts'

/** Visitors reach the panel on the local network only. */
export const lanOnlyProvider = createListenerProvider('lan-only', { reach: 'lan' })
