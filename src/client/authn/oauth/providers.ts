/**
 * GitHub and Google OAuth providers for control-plane sign-in / account link.
 *
 * Authorize URLs are built here; the browser navigates to them. Token exchange
 * and identity fetches use a bare `fetch` with explicit error mapping — same
 * style as `postTokenGrant` in `src/lib/git/gitlab-oauth-token.ts`. No I/O at
 * module load (Workers 10021).
 */

export type OAuthProviderId = "github" | "google";

export type OAuthIdentity = {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export type OAuthProviderCredentials = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type OAuthAuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string;
};

export interface OAuthProvider {
  readonly id: OAuthProviderId;
  readonly tokenUrl: string;
  readonly scopes: string;
  authorizeUrl(params: OAuthAuthorizeParams): string;
  fetchIdentity(accessToken: string): Promise<OAuthIdentity>;
}

export class OAuthProviderError extends Error {
  /** HTTP status from the provider, when the failure came from the API. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OAuthProviderError";
    this.status = status;
  }
}

export type ResolvedOAuthProvider = {
  id: OAuthProviderId;
  buildAuthorizeUrl: (state: string) => string;
  exchangeCode: (code: string) => Promise<{ accessToken: string }>;
  fetchIdentity: (accessToken: string) => Promise<OAuthIdentity>;
};

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const GITHUB_SCOPES = "read:user user:email";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_SCOPES = "openid email profile";

const PROVIDER_USER_AGENT = "TurboPanel";

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return value === "github" || value === "google";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readProviderError(
  response: Response,
  provider: OAuthProviderId,
): Promise<string> {
  const body = await response.text().catch(() => "");
  if (!body) return `${provider} request failed (${response.status})`;
  try {
    const parsed = JSON.parse(body) as {
      error_description?: unknown;
      error?: unknown;
      message?: unknown;
    };
    for (
      const field of [parsed.error_description, parsed.message, parsed.error]
    ) {
      if (typeof field === "string" && field.length > 0) {
        return `${provider} request failed (${response.status}): ${field}`;
      }
    }
  } catch {
    // Non-JSON error body — fall through to the status-only message.
  }
  return `${provider} request failed (${response.status})`;
}

async function postTokenGrant(
  provider: OAuthProviderId,
  tokenUrl: string,
  form: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const body = new URLSearchParams(form);

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...extraHeaders,
      },
      body: body.toString(),
    });
  } catch (error) {
    throw new OAuthProviderError(
      `${provider} token exchange failed: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }

  if (!response.ok) {
    throw new OAuthProviderError(
      await readProviderError(response, provider),
      response.status,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { access_token?: unknown }
    | null;
  if (
    !payload || typeof payload.access_token !== "string" ||
    payload.access_token.length === 0
  ) {
    throw new OAuthProviderError(
      `${provider} token exchange returned no token`,
    );
  }

  return payload.access_token;
}

async function getJson(
  provider: OAuthProviderId,
  url: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...extraHeaders,
      },
    });
  } catch (error) {
    throw new OAuthProviderError(
      `${provider} identity request failed: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }

  if (!response.ok) {
    throw new OAuthProviderError(
      await readProviderError(response, provider),
      response.status,
    );
  }

  return await response.json().catch(() => null);
}

function githubAuthorizeUrl(params: OAuthAuthorizeParams): string {
  const target = new URL(GITHUB_AUTHORIZE_URL);
  target.searchParams.set("client_id", params.clientId);
  target.searchParams.set("redirect_uri", params.redirectUri);
  target.searchParams.set("scope", GITHUB_SCOPES);
  target.searchParams.set("state", params.state);
  return target.toString();
}

function googleAuthorizeUrl(params: OAuthAuthorizeParams): string {
  const target = new URL(GOOGLE_AUTHORIZE_URL);
  target.searchParams.set("client_id", params.clientId);
  target.searchParams.set("redirect_uri", params.redirectUri);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", GOOGLE_SCOPES);
  target.searchParams.set("state", params.state);
  return target.toString();
}

function pickGithubEmail(
  payload: unknown,
): { email: string; verified: boolean } | null {
  if (!Array.isArray(payload)) return null;
  const emails = payload.filter(isPlainObject);
  const primaryVerified = emails.find((row) =>
    row.primary === true && row.verified === true &&
    typeof row.email === "string" &&
    row.email.length > 0
  );
  if (primaryVerified && typeof primaryVerified.email === "string") {
    return { email: primaryVerified.email, verified: true };
  }
  return null;
}

function githubProviderUserId(id: unknown): string | null {
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  return null;
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed;
}

async function fetchGithubIdentity(
  accessToken: string,
): Promise<OAuthIdentity> {
  const userPayload = await getJson("github", GITHUB_USER_URL, accessToken, {
    "user-agent": PROVIDER_USER_AGENT,
  });
  if (!isPlainObject(userPayload)) {
    throw new OAuthProviderError("github identity request returned no user");
  }

  const providerUserId = githubProviderUserId(userPayload.id);
  if (!providerUserId) {
    throw new OAuthProviderError("github identity request returned no user id");
  }

  const emailsPayload = await getJson(
    "github",
    GITHUB_EMAILS_URL,
    accessToken,
    {
      "user-agent": PROVIDER_USER_AGENT,
    },
  );
  const email = pickGithubEmail(emailsPayload);
  if (!email) {
    throw new OAuthProviderError(
      "github identity request returned no verified email",
    );
  }

  const name = optionalTrimmedString(userPayload.name) ??
    optionalTrimmedString(userPayload.login);

  return {
    providerUserId,
    email: email.email,
    emailVerified: email.verified,
    name,
  };
}

async function fetchGoogleIdentity(
  accessToken: string,
): Promise<OAuthIdentity> {
  const payload = await getJson("google", GOOGLE_USERINFO_URL, accessToken);
  if (!isPlainObject(payload)) {
    throw new OAuthProviderError("google identity request returned no user");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new OAuthProviderError("google identity request returned no subject");
  }
  const email = payload.email;
  if (typeof email !== "string" || email.length === 0) {
    throw new OAuthProviderError("google identity request returned no email");
  }

  const name = optionalTrimmedString(payload.name);

  return {
    providerUserId: sub,
    email,
    emailVerified: payload.email_verified === true,
    name,
  };
}

const githubProvider: OAuthProvider = {
  id: "github",
  tokenUrl: GITHUB_TOKEN_URL,
  scopes: GITHUB_SCOPES,
  authorizeUrl: githubAuthorizeUrl,
  fetchIdentity: fetchGithubIdentity,
};

const googleProvider: OAuthProvider = {
  id: "google",
  tokenUrl: GOOGLE_TOKEN_URL,
  scopes: GOOGLE_SCOPES,
  authorizeUrl: googleAuthorizeUrl,
  fetchIdentity: fetchGoogleIdentity,
};

function providerById(id: OAuthProviderId): OAuthProvider {
  return id === "github" ? githubProvider : googleProvider;
}

/**
 * Bind credentials onto a provider: authorize URL + code exchange + identity.
 */
export function resolveOAuthProvider(
  id: OAuthProviderId,
  credentials: OAuthProviderCredentials,
): ResolvedOAuthProvider {
  const provider = providerById(id);
  return {
    id,
    buildAuthorizeUrl: (state: string) =>
      provider.authorizeUrl({
        clientId: credentials.clientId,
        redirectUri: credentials.redirectUri,
        state,
      }),
    exchangeCode: async (code: string) => {
      const accessToken = await postTokenGrant(
        id,
        provider.tokenUrl,
        {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          code,
          redirect_uri: credentials.redirectUri,
          grant_type: "authorization_code",
        },
        id === "github" ? { "user-agent": PROVIDER_USER_AGENT } : {},
      );
      return { accessToken };
    },
    fetchIdentity: (accessToken: string) => provider.fetchIdentity(accessToken),
  };
}
