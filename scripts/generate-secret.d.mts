/** Types for `generate-secret.mjs` (shared by the CLI and `src/lib/secrets`). */
export declare const ALPHABET: string
export declare const SECRET_LENGTH: number
export declare function generateSecret(length?: number): string
export declare const generatePassword: typeof generateSecret
