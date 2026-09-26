const textEncoder = new TextEncoder()

/** Compare two byte strings without an early exit on the first difference. */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

/** {@link constantTimeEqualBytes} over the UTF-8 encodings of two strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  return constantTimeEqualBytes(textEncoder.encode(a), textEncoder.encode(b))
}
