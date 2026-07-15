/**
 * Minimal DER/ASN.1 reader for X.509 certificate parsing (Workers + Deno safe).
 */

export class Asn1Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Asn1Error'
  }
}

export type Asn1Node = {
  tag: number
  headerLength: number
  contentOffset: number
  contentLength: number
  /** Absolute end offset in the parent buffer. */
  end: number
  bytes: Uint8Array
}

export function readNode(bytes: Uint8Array, offset = 0): Asn1Node {
  if (offset >= bytes.length) {
    throw new Asn1Error('unexpected end of DER')
  }
  const tag = bytes[offset]!
  let cursor = offset + 1
  if (cursor >= bytes.length) {
    throw new Asn1Error('missing length')
  }
  const firstLen = bytes[cursor]!
  cursor += 1
  let contentLength: number
  let headerLength: number
  if ((firstLen & 0x80) === 0) {
    contentLength = firstLen
    headerLength = 2
  } else {
    const lenBytes = firstLen & 0x7f
    if (lenBytes === 0 || lenBytes > 4) {
      throw new Asn1Error('unsupported DER length')
    }
    if (cursor + lenBytes > bytes.length) {
      throw new Asn1Error('truncated length')
    }
    contentLength = 0
    for (let i = 0; i < lenBytes; i += 1) {
      contentLength = (contentLength << 8) | bytes[cursor + i]!
    }
    cursor += lenBytes
    headerLength = 2 + lenBytes
  }
  const contentOffset = cursor
  const end = contentOffset + contentLength
  if (end > bytes.length) {
    throw new Asn1Error('truncated content')
  }
  return {
    tag,
    headerLength,
    contentOffset,
    contentLength,
    end,
    bytes,
  }
}

export function content(node: Asn1Node): Uint8Array {
  return node.bytes.subarray(node.contentOffset, node.end)
}

export function children(node: Asn1Node): Asn1Node[] {
  if ((node.tag & 0x20) === 0) {
    return []
  }
  const out: Asn1Node[] = []
  let offset = node.contentOffset
  while (offset < node.end) {
    const child = readNode(node.bytes, offset)
    out.push(child)
    offset = child.end
  }
  return out
}

export function expectTag(node: Asn1Node, tag: number, label: string): void {
  if (node.tag !== tag) {
    throw new Asn1Error(`expected ${label} tag 0x${tag.toString(16)}, got 0x${node.tag.toString(16)}`)
  }
}

/** Decode ASN.1 INTEGER (unsigned, strip leading zero). */
export function readInteger(node: Asn1Node): Uint8Array {
  expectTag(node, 0x02, 'INTEGER')
  const raw = content(node)
  if (raw.length > 1 && raw[0] === 0x00) {
    return raw.subarray(1)
  }
  return raw
}

export function readOid(node: Asn1Node): string {
  expectTag(node, 0x06, 'OBJECT IDENTIFIER')
  const raw = content(node)
  if (raw.length === 0) {
    throw new Asn1Error('empty OID')
  }
  const first = raw[0]!
  const parts = [Math.floor(first / 40), first % 40]
  let value = 0
  for (let i = 1; i < raw.length; i += 1) {
    const byte = raw[i]!
    value = (value << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

export function readUtf8OrPrintable(node: Asn1Node): string {
  const raw = content(node)
  // UTF8String / PrintableString / IA5String / TeletexString
  return new TextDecoder().decode(raw)
}

/** Decode UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ). */
export function readTime(node: Asn1Node): Date {
  const raw = new TextDecoder().decode(content(node)).trim()
  let iso: string
  if (node.tag === 0x17) {
    // UTCTime: YYMMDDHHMMSSZ — years 00-49 → 2000+, 50-99 → 1900+
    if (!/^\d{12}Z$/.test(raw)) {
      throw new Asn1Error(`invalid UTCTime: ${raw}`)
    }
    const yy = Number(raw.slice(0, 2))
    const year = yy >= 50 ? 1900 + yy : 2000 + yy
    iso =
      `${String(year).padStart(4, '0')}-${raw.slice(2, 4)}-${raw.slice(4, 6)}` +
      `T${raw.slice(6, 8)}:${raw.slice(8, 10)}:${raw.slice(10, 12)}Z`
  } else if (node.tag === 0x18) {
    if (!/^\d{14}Z$/.test(raw)) {
      throw new Asn1Error(`invalid GeneralizedTime: ${raw}`)
    }
    iso =
      `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` +
      `T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`
  } else {
    throw new Asn1Error(`expected time tag, got 0x${node.tag.toString(16)}`)
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    throw new Asn1Error(`invalid time value: ${raw}`)
  }
  return date
}
