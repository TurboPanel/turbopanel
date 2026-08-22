import type { OtpType } from './types.ts'

export interface TemplateResult {
  subject: string
  html: string
  text: string
}

const OTP_SUBJECTS: Record<OtpType, string> = {
  'sign-in': 'Your TurboPanel sign-in code',
  'email-verification': 'Verify your TurboPanel email',
  'forget-password': 'Reset your TurboPanel password',
}

const OTP_INTROS: Record<OtpType, string> = {
  'sign-in': 'Use this code to sign in to TurboPanel.',
  'email-verification': 'Use this code to verify your email address for TurboPanel.',
  'forget-password': 'Use this code to reset your TurboPanel password.',
}

export function createEmailVerificationLinkEmail(
  _recipientEmail: string,
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

export function createEmailOtpEmail(
  _recipientEmail: string,
  otp: string,
  otpType: OtpType,
): TemplateResult {
  const subject = OTP_SUBJECTS[otpType]
  const intro = OTP_INTROS[otpType]
  const safeOtp = escapeHtml(otp)
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:32px;">
    <h1 style="margin:0 0 16px;font-size:24px;color:#111;">${escapeHtml(subject)}</h1>
    <p style="margin:0 0 24px;color:#444;line-height:1.5;">${escapeHtml(intro)}</p>
    <p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:0.25em;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#111;text-align:center;padding:16px;background:#f3f4f6;border-radius:8px;">${safeOtp}</p>
    <p style="margin:0;font-size:14px;color:#666;">Enter this code in TurboPanel. It expires soon.</p>
    <p style="margin:16px 0 0;font-size:12px;color:#999;">TurboPanel – Self-hosted control plane</p>
  </div>
</body>
</html>
`.trim()
  const text =
    `${subject}\n\n${intro}\n\nYour code: ${otp}\n\n` +
    `Enter this code in TurboPanel. It expires soon.\n\nTurboPanel – Self-hosted control plane`
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
