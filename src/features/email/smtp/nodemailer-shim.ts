const SMTP_UNAVAILABLE = 'SMTP not available on Workers'

function rejectSmtp(): never {
  throw new Error(SMTP_UNAVAILABLE)
}

export default {
  createTransport() {
    return rejectSmtp()
  },
}
