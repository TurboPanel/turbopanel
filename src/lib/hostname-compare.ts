/**
 * One spelling of a hostname for comparing names that come from different
 * places: lowercase, no port, no scheme or brackets, no trailing dot, and
 * punycode for international names. A leading `*.` wildcard label is kept as
 * written. Returns the cleaned lowercase text when the name cannot be parsed,
 * so two unparsable but identical spellings still compare equal.
 */
export function normalizeHostForCompare(raw: string): string {
  let text = raw.trim().toLowerCase()
  const wildcard = text.startsWith('*.')
  if (wildcard) text = text.slice(2)
  // A bare IPv6 literal has several colons and no brackets; bracket it so the
  // port is not mistaken for its last group.
  if (!text.includes('://') && !text.startsWith('[') && text.split(':').length > 2) {
    text = `[${text}]`
  }
  let host = text
  try {
    host = new URL(text.includes('://') ? text : `https://${text}`).hostname
  } catch {
    host = text.replace(/:\d+$/, '')
  }
  host = stripTrailingDots(host.replace(/^\[|\]$/g, ''))
  return wildcard ? `*.${host}` : host
}

function stripTrailingDots(host: string): string {
  let end = host.length
  while (end > 0 && host[end - 1] === '.') end--
  return host.slice(0, end)
}
