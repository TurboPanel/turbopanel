export interface TemplateResult {
  subject: string
  html: string
  text: string
}

export function createEmailVerificationLinkEmail(
  recipientEmail: string,
  verifyUrl: string,
): TemplateResult {
  const subject = 'Verify your TurboPanel email'
  const safeUrl = escapeHtml(verifyUrl)
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:32px;">
    <h1 style="margin:0 0 16px;font-size:24px;color:#111;">Verify your email</h1>
    <p style="margin:0 0 24px;color:#444;line-height:1.5;">Confirm your email address for TurboPanel.</p>
    <p style="margin:0 0 24px;">
      <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Verify email</a>
    </p>
    <p style="margin:0;font-size:14px;color:#666;">If you didn't sign up, you can ignore this email.</p>
    <p style="margin:16px 0 0;font-size:12px;color:#999;">TurboPanel – Self-hosted control plane</p>
  </div>
</body>
</html>
`.trim()
  const text =
    `Verify your TurboPanel email\n\nOpen this link:\n${verifyUrl}\n\n` +
    `If you didn't sign up, ignore this email.\n\nTurboPanel – Self-hosted control plane`
  return { subject, html, text }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
