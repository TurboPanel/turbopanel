const denoClientStatusSchema = {
  type: "object",
  required: [
    "ok",
    "runtime",
    "needsInstall",
    "isInstallMode",
    "isSignupEnabled",
    "billingEnabled",
    "authProviders",
  ],
  description:
    "Public client status on Deno self-hosted. Reflects install wizard and sign-up state.",
  properties: {
    ok: { type: "boolean", const: true },
    runtime: {
      type: "string",
      const: "deno",
      description:
        "Control-plane runtime. Self-hosted Deno uses green auth chrome in the UI.",
    },
    needsInstall: {
      type: "boolean",
      description: "True when org + superadmin do not exist yet.",
    },
    isInstallMode: {
      type: "boolean",
      description: "True while the install wizard is active.",
    },
    isSignupEnabled: {
      type: "boolean",
      description:
        "Whether public sign-up is enabled. The `IS_SIGNUP_ENABLED` database setting wins unless `TURBOPANEL_IS_SIGNUP_ENABLED` is set to an explicit force-enable (`1`/`true`) or force-disable (`0`/`false`). Defaults to false when both are unset.",
    },
    billingEnabled: {
      type: "boolean",
      description:
        "Whether customer billing is operational (Stripe API key and webhook signing secret). Presence only — the console hides the billing area wholesale when false. Never the keys.",
    },
    authProviders: {
      type: "array",
      items: { type: "string", enum: ["github", "google"] },
      description:
        "Configured OAuth sign-in providers. Presence only — client ids and secrets are never returned.",
    },
  },
} as const;

const workersClientStatusSchema = {
  type: "object",
  required: [
    "ok",
    "runtime",
    "isSignupEnabled",
    "billingEnabled",
    "authProviders",
  ],
  description:
    "Public client status on Cloudflare Workers. Install fields are omitted — Workers bootstraps via public sign-up.",
  properties: {
    ok: { type: "boolean", const: true },
    runtime: {
      type: "string",
      const: "workers",
      description:
        "Control-plane runtime. TurboPanel High Availability (Workers) uses blue auth chrome in the UI.",
    },
    isSignupEnabled: {
      type: "boolean",
      description:
        "Whether public sign-up is enabled. The `IS_SIGNUP_ENABLED` database setting wins unless `TURBOPANEL_IS_SIGNUP_ENABLED` is set to an explicit force-enable (`1`/`true`) or force-disable (`0`/`false`). Defaults to false when both are unset so production can open sign-up from the panel without a deploy.",
    },
    billingEnabled: {
      type: "boolean",
      description:
        "Whether customer billing is operational (Stripe API key and webhook signing secret). Presence only — the console hides the billing area wholesale when false. Never the keys.",
    },
    authProviders: {
      type: "array",
      items: { type: "string", enum: ["github", "google"] },
      description:
        "Configured OAuth sign-in providers. Presence only — client ids and secrets are never returned.",
    },
  },
} as const;

const denoSessionResponseSchema = {
  type: "object",
  required: [
    "ok",
    "userId",
    "email",
    "role",
    "needsInstall",
    "is2faEnabled",
  ],
  properties: {
    ok: { type: "boolean", const: true },
    userId: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    role: { type: ["string", "null"] },
    needsInstall: { type: "boolean" },
    is2faEnabled: { type: "boolean" },
  },
} as const;

const workersSessionResponseSchema = {
  type: "object",
  required: ["ok", "userId", "email", "role", "is2faEnabled"],
  description:
    "Session payload on Workers. needsInstall is omitted — Workers has no install wizard.",
  properties: {
    ok: { type: "boolean", const: true },
    userId: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    role: { type: ["string", "null"] },
    is2faEnabled: { type: "boolean" },
  },
} as const;

export function buildAuthSchemas(runtime?: "deno" | "workers") {
  const includeInstall = runtime !== "workers";
  return {
    OkHealth: {
      type: "object",
      required: ["ok", "license", "revision"],
      properties: {
        ok: { type: "boolean", const: true },
        license: { type: "string", const: "AGPL-3.0-only" },
        revision: {
          type: "object",
          required: ["commit", "sourceUrl"],
          properties: {
            commit: { type: "string" },
            sourceUrl: { type: "string", format: "uri" },
          },
        },
      },
    },
    ClientStatus: includeInstall
      ? denoClientStatusSchema
      : workersClientStatusSchema,
    ErrorResponse: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean", const: false },
        error: { type: "string" },
      },
    },
    UnauthorizedResponse: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean", const: false },
      },
    },
    SignInRequest: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", format: "password" },
      },
    },
    SessionResponse: includeInstall
      ? denoSessionResponseSchema
      : workersSessionResponseSchema,
    Requires2faResponse: {
      type: "object",
      required: ["ok", "requires2fa", "challenge"],
      properties: {
        ok: { type: "boolean", const: true },
        requires2fa: { type: "boolean", const: true },
        challenge: {
          type: "string",
          description:
            "Stateless `tp2fa` envelope; submit to POST /auth/sign-in/2fa",
        },
      },
    },
    TwoFactorStatus: {
      type: "object",
      required: [
        "enabled",
        "method",
        "backupCodesRemaining",
        "passkeys",
        "linkedProviders",
      ],
      properties: {
        enabled: { type: "boolean" },
        method: { type: ["string", "null"], enum: ["totp", null] },
        backupCodesRemaining: { type: "integer" },
        passkeys: {
          type: "array",
          items: { $ref: "#/components/schemas/PasskeySummary" },
        },
        linkedProviders: {
          type: "array",
          items: { type: "string", enum: ["github", "google"] },
          description:
            "OAuth providers linked to this account (excludes the password credential)",
        },
      },
    },
    TotpEnrollResponse: {
      type: "object",
      required: ["secret", "otpauthUri"],
      properties: {
        secret: { type: "string" },
        otpauthUri: { type: "string" },
      },
    },
    BackupCodesResponse: {
      type: "object",
      required: ["backupCodes"],
      properties: {
        backupCodes: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    SignIn2faRequest: {
      type: "object",
      required: ["challenge"],
      properties: {
        challenge: { type: "string" },
        code: { type: "string" },
        backupCode: { type: "string" },
      },
    },
    PasskeySummary: {
      type: "object",
      required: ["id", "name", "createdAt", "deviceType", "isBackedUp"],
      properties: {
        id: { type: "string" },
        name: { type: ["string", "null"] },
        createdAt: { type: "string" },
        deviceType: { type: "string" },
        isBackedUp: { type: "boolean" },
      },
    },
    PasskeyListResponse: {
      type: "object",
      required: ["passkeys"],
      properties: {
        passkeys: {
          type: "array",
          items: { $ref: "#/components/schemas/PasskeySummary" },
        },
      },
    },
    PasskeyCeremonyResponse: {
      type: "object",
      required: ["challenge", "options"],
      properties: {
        challenge: {
          type: "string",
          description:
            "Stateless `tpwebauthn` envelope; submit to the matching verify route",
        },
        options: {
          type: "object",
          description:
            "PublicKeyCredential options with base64url-encoded binary fields",
        },
      },
    },
    PasskeyRegisterVerifyRequest: {
      type: "object",
      required: ["challenge", "name", "credential"],
      properties: {
        challenge: { type: "string" },
        name: { type: "string" },
        credential: { type: "object" },
      },
    },
    PasskeyLoginVerifyRequest: {
      type: "object",
      required: ["challenge", "credential"],
      properties: {
        challenge: { type: "string" },
        credential: { type: "object" },
      },
    },
    PasskeyCreatedResponse: {
      type: "object",
      required: ["ok", "id"],
      properties: {
        ok: { type: "boolean", const: true },
        id: { type: "string" },
      },
    },
    SignOutResponse: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean", const: true },
      },
    },
    SignUpRequest: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", format: "password" },
      },
    },
    SignUpResponse: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean", const: true },
      },
    },
    VerifyEmailResponse: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean", const: true },
      },
    },
    OtpType: {
      type: "string",
      enum: ["sign-in", "email-verification", "forget-password"],
    },
    SendOtpRequest: {
      type: "object",
      required: ["email", "type"],
      properties: {
        email: { type: "string", format: "email" },
        type: { $ref: "#/components/schemas/OtpType" },
      },
    },
    VerifyOtpRequest: {
      type: "object",
      required: ["email", "otp", "type"],
      properties: {
        email: { type: "string", format: "email" },
        otp: { type: "string" },
        type: { $ref: "#/components/schemas/OtpType" },
      },
    },
    SignInOtpRequest: {
      type: "object",
      required: ["email", "otp"],
      properties: {
        email: { type: "string", format: "email" },
        otp: { type: "string" },
        name: { type: "string" },
      },
    },
    VerifyEmailOtpRequest: {
      type: "object",
      required: ["email", "otp"],
      properties: {
        email: { type: "string", format: "email" },
        otp: { type: "string" },
      },
    },
    RequestPasswordResetOtpRequest: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", format: "email" },
      },
    },
    ResetPasswordOtpRequest: {
      type: "object",
      required: ["email", "otp", "password"],
      properties: {
        email: { type: "string", format: "email" },
        otp: { type: "string" },
        password: { type: "string", format: "password" },
      },
    },
    OkResponse: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean", const: true },
      },
    },
  };
}

export const authPaths: Record<string, unknown> = {
  "/api/health": {
    get: {
      tags: ["Health"],
      summary: "Health probe",
      responses: {
        "200": {
          description: "Instance is reachable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkHealth" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/status": {
    get: {
      tags: ["Health"],
      summary: "Public client status",
      description:
        "Install and sign-up flags for the client UI. Replaces the former GET /api/install/v1/status for client callers.",
      responses: {
        "200": {
          description: "Client status",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ClientStatus" },
            },
          },
        },
        "503": {
          description: "Database unavailable (Deno self-hosted only)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/sign-in": {
    post: {
      tags: ["Authentication"],
      summary: "Sign in with email credentials",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SignInRequest" },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Signed in (session cookie set) or TOTP challenge required",
          headers: {
            "Set-Cookie": {
              schema: { type: "string" },
              description: "Signed session cookie (omitted when requires2fa)",
            },
          },
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/SessionResponse" },
                  { $ref: "#/components/schemas/Requires2faResponse" },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid request body",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid credentials",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description: "Root account must use install wizard",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/sign-out": {
    post: {
      tags: ["Authentication"],
      summary: "Sign out and clear session cookie",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description: "Signed out",
          headers: {
            "Set-Cookie": {
              schema: { type: "string" },
              description: "Clears session cookie",
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SignOutResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/authn/session": {
    get: {
      tags: ["Authorization"],
      summary: "Get current session",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description: "Active session",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SessionResponse" },
            },
          },
        },
        "401": {
          description: "No valid session",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UnauthorizedResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/sign-up": {
    post: {
      tags: ["Authentication"],
      summary: "Create a user account when sign-up is enabled",
      description:
        "Creates a regular user account when sign-up is enabled (`IS_SIGNUP_ENABLED` DB setting, or `TURBOPANEL_IS_SIGNUP_ENABLED` force override). On Deno self-hosted, the install wizard must complete first. On Workers, sign-up is the first-user bootstrap path. No session is returned — the user must sign in after verifying email.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SignUpRequest" },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Account created; verification email queued when available",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SignUpResponse" },
            },
          },
        },
        "400": {
          description: "Invalid request body or validation error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description:
            "Deno self-hosted: install incomplete. Any runtime: sign-up disabled.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "409": {
          description: "Email already registered",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "500": {
          description: "Sign-up failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/verify-email": {
    get: {
      tags: ["Authentication"],
      summary: "Verify email with a one-time token",
      description:
        "Consumes a 24-hour email verification token and sets `user.isEmailVerified` to true.",
      parameters: [
        {
          name: "token",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Verification token from the signup email link",
        },
      ],
      responses: {
        "200": {
          description: "Email verified",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/VerifyEmailResponse" },
            },
          },
        },
        "400": {
          description: "Missing, invalid, or expired token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/send-otp": {
    post: {
      tags: ["Authentication"],
      summary: "Send an OTP to an email address",
      description:
        "Generates a short-lived OTP and queues an email. Never reveals whether the email is registered. `email-verification` requires an active session.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SendOtpRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP queued (or silently accepted)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkResponse" },
            },
          },
        },
        "400": {
          description: "Invalid request body",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "401": {
          description: "Session required for email-verification OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/verify-otp": {
    post: {
      tags: ["Authentication"],
      summary: "Check OTP validity (optional step)",
      description:
        "Validates an OTP without consuming it. Failed attempts count toward the per-OTP attempt limit.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/VerifyOtpRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP is valid",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkResponse" },
            },
          },
        },
        "400": {
          description: "Invalid or expired OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "429": {
          description: "Too many attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/sign-in/otp": {
    post: {
      tags: ["Authentication"],
      summary: "Sign in (or auto-register) with OTP",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SignInOtpRequest" },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Signed in (session cookie set) or TOTP challenge required",
          headers: {
            "Set-Cookie": {
              schema: { type: "string" },
              description: "Signed session cookie (omitted when requires2fa)",
            },
          },
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/SessionResponse" },
                  { $ref: "#/components/schemas/Requires2faResponse" },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid request or OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description:
            "Deno self-hosted: install incomplete. Any runtime: auto-registration disabled.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "429": {
          description: "Too many OTP attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/verify-email/otp": {
    post: {
      tags: ["Authentication"],
      summary: "Verify email address with OTP",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/VerifyEmailOtpRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Email verified",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkResponse" },
            },
          },
        },
        "400": {
          description: "Invalid or expired OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "401": {
          description: "Session required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "429": {
          description: "Too many attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/reset-password/request-otp": {
    post: {
      tags: ["Authentication"],
      summary: "Request a password-reset OTP",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/RequestPasswordResetOtpRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP queued (or silently accepted)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkResponse" },
            },
          },
        },
        "400": {
          description: "Invalid request body",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/reset-password/otp": {
    post: {
      tags: ["Authentication"],
      summary: "Reset password using OTP",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ResetPasswordOtpRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Password updated",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkResponse" },
            },
          },
        },
        "400": {
          description: "Invalid request, OTP, or password",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "User or credential account not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "429": {
          description: "Too many OTP attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/2fa": {
    get: {
      tags: ["Authentication"],
      summary: "Current two-factor status",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description:
            "Enrolment status, remaining backup codes, passkeys, and linked OAuth providers",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TwoFactorStatus" },
            },
          },
        },
        "401": {
          description: "Not signed in",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UnauthorizedResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/2fa/totp/enroll": {
    post: {
      tags: ["Authentication"],
      summary: "Begin TOTP enrolment",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { password: { type: "string", format: "password" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Authenticator secret (shown once)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TotpEnrollResponse" },
            },
          },
        },
        "403": {
          description: "Reauthentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "409": {
          description: "Two-factor already enabled",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/2fa/totp/verify": {
    post: {
      tags: ["Authentication"],
      summary: "Confirm TOTP enrolment",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["code"],
              properties: { code: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Backup codes (shown once)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BackupCodesResponse" },
            },
          },
        },
        "400": {
          description: "Invalid code or not enrolled",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/2fa/backup-codes/regenerate": {
    post: {
      tags: ["Authentication"],
      summary: "Replace remaining backup codes",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { password: { type: "string", format: "password" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "New backup codes (shown once)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BackupCodesResponse" },
            },
          },
        },
        "403": {
          description: "Reauthentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/2fa/disable": {
    post: {
      tags: ["Authentication"],
      summary: "Disable two-factor authentication",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { password: { type: "string", format: "password" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Two-factor disabled",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkResponse" },
            },
          },
        },
        "403": {
          description: "Reauthentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/sign-in/2fa": {
    post: {
      tags: ["Authentication"],
      summary: "Complete sign-in with a TOTP or backup code",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SignIn2faRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Signed in; session cookie set",
          headers: {
            "Set-Cookie": {
              schema: { type: "string" },
              description: "Signed session cookie",
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SessionResponse" },
            },
          },
        },
        "400": {
          description: "Invalid code or challenge",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "429": {
          description: "Too many attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/passkeys/register/options": {
    post: {
      tags: ["Authentication"],
      summary: "Begin passkey registration",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { password: { type: "string", format: "password" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "WebAuthn creation options and signed challenge",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PasskeyCeremonyResponse" },
            },
          },
        },
        "401": {
          description: "Not signed in",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UnauthorizedResponse" },
            },
          },
        },
        "403": {
          description: "Reauthentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/passkeys/register/verify": {
    post: {
      tags: ["Authentication"],
      summary: "Finish passkey registration",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/PasskeyRegisterVerifyRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Passkey stored",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PasskeyCreatedResponse" },
            },
          },
        },
        "400": {
          description: "Invalid credential or challenge",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "409": {
          description: "Credential already registered",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/passkeys": {
    get: {
      tags: ["Authentication"],
      summary: "List registered passkeys",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description: "Passkeys for the signed-in user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PasskeyListResponse" },
            },
          },
        },
        "401": {
          description: "Not signed in",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UnauthorizedResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/passkeys/{id}": {
    delete: {
      tags: ["Authentication"],
      summary: "Delete a registered passkey",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { password: { type: "string", format: "password" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Passkey deleted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OkResponse" },
            },
          },
        },
        "401": {
          description: "Not signed in",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UnauthorizedResponse" },
            },
          },
        },
        "403": {
          description: "Reauthentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Passkey not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/passkeys/login/options": {
    post: {
      tags: ["Authentication"],
      summary: "Begin passkey sign-in",
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { type: "object" },
          },
        },
      },
      responses: {
        "200": {
          description: "WebAuthn request options and signed challenge",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PasskeyCeremonyResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/passkeys/login/verify": {
    post: {
      tags: ["Authentication"],
      summary: "Complete sign-in with a passkey",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PasskeyLoginVerifyRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Signed in; session cookie set",
          headers: {
            "Set-Cookie": {
              schema: { type: "string" },
              description: "Signed session cookie",
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SessionResponse" },
            },
          },
        },
        "400": {
          description: "Invalid credential",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/auth/oauth/{provider}/start": {
    get: {
      tags: ["Authentication"],
      summary: "Begin GitHub or Google OAuth sign-in or account link",
      description:
        "Redirects the browser to the provider authorize URL. `link=1` requires an existing session and binds the callback to that user.",
      parameters: [
        {
          name: "provider",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["github", "google"] },
        },
        {
          name: "redirectTo",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Same-origin path to return to after sign-in (default `/`).",
        },
        {
          name: "link",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["1"] },
          description:
            "When `1`, link this provider to the current session instead of signing in.",
        },
      ],
      responses: {
        "302": {
          description:
            "Redirect to the provider authorize URL (Location header) with an S256 PKCE challenge; sets the HttpOnly OAuth flow cookie the callback requires. Unconfigured provider: 404. Rate-limited: 429.",
        },
        "404": { description: "Provider is not configured" },
        "429": { description: "Too many requests" },
      },
    },
  },
  "/api/client/v1/auth/oauth/{provider}/callback": {
    get: {
      tags: ["Authentication"],
      summary: "Complete GitHub or Google OAuth sign-in or account link",
      description:
        "Redirect-only. The state must come back on the browser that started the flow: `/start` sets a short-lived HttpOnly flow cookie holding the PKCE verifier, and the callback requires it to match the state and sends it to the provider (RFC 7636, S256). The cookie is cleared on every callback. Success sets the session cookie (or a `tp2fa` challenge) and redirects to `redirectTo` from the signed state. Failures redirect to `/sign-in?error=` with `oauth_state_invalid` (also when the flow cookie is missing or does not match), `oauth_exchange_failed`, `account_disabled`, `oauth_signup_disabled`, `oauth_email_unverified` (sign-up with an email the provider has not verified), `account_conflict`, `not_configured`, or `database_unavailable`. Link success redirects to `/account/security?linked=<provider>`; link failures to `/account/security?linked=&error=` (`account_conflict`, `not_configured`, `database_unavailable`). Never returns a JSON body.",
      parameters: [
        {
          name: "provider",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["github", "google"] },
        },
        {
          name: "code",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "state",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Signed `tpoauth` envelope from the start hop",
        },
      ],
      responses: {
        "302": {
          description:
            "Redirect to `redirectTo`, `/sign-in?challenge=`, `/sign-in?error=`, or `/account/security`. Session cookie is set on successful non-2FA sign-in.",
          headers: {
            Location: { schema: { type: "string" } },
            "Set-Cookie": {
              schema: { type: "string" },
              description:
                "Signed session cookie on successful sign-in without 2FA",
            },
          },
        },
        "429": { description: "Too many requests" },
      },
    },
  },
  "/api/client/v1/auth/oauth/{provider}": {
    delete: {
      tags: ["Authentication"],
      summary: "Unlink a GitHub or Google account",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "provider",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["github", "google"] },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { password: { type: "string", format: "password" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Unlinked",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "401": { description: "Unauthorized" },
        "403": { description: "Step-up reauth required" },
        "404": { description: "No linked account for this provider" },
        "409": {
          description:
            "`last_sign_in_method` — no credential account, other provider account, or passkey would remain",
        },
      },
    },
  },
};
