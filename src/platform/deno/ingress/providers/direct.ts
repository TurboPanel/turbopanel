import { createListenerProvider } from './listener.ts'

/** Visitors reach the panel's own listener on the public internet. */
export const directProvider = createListenerProvider('direct', { listener: ':8443' })
