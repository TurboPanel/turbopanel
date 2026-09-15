import { assertEquals, assertRejects } from "@std/assert";
import { OAuthProviderError, resolveOAuthProvider } from "./providers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const GITHUB_CREDS = {
  clientId: "gh-client",
  clientSecret: "gh-secret",
  redirectUri:
    "https://panel.example.com/api/client/v1/auth/oauth/github/callback",
};
const GOOGLE_CREDS = {
  clientId: "go-client",
  clientSecret: "go-secret",
  redirectUri:
    "https://panel.example.com/api/client/v1/auth/oauth/google/callback",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("github authorize URL includes client_id, redirect, scope, and state", () => {
  const provider = resolveOAuthProvider("github", GITHUB_CREDS);
  const url = new URL(provider.buildAuthorizeUrl("state-token"));
  assertEquals(
    url.origin + url.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assertEquals(url.searchParams.get("client_id"), "gh-client");
  assertEquals(url.searchParams.get("redirect_uri"), GITHUB_CREDS.redirectUri);
  assertEquals(url.searchParams.get("scope"), "read:user user:email");
  assertEquals(url.searchParams.get("state"), "state-token");
});

test("google authorize URL includes openid scopes and response_type=code", () => {
  const provider = resolveOAuthProvider("google", GOOGLE_CREDS);
  const url = new URL(provider.buildAuthorizeUrl("state-token"));
  assertEquals(
    url.origin + url.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assertEquals(url.searchParams.get("client_id"), "go-client");
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("scope"), "openid email profile");
  assertEquals(url.searchParams.get("state"), "state-token");
});

test("github token exchange and identity parse the primary verified email", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      assertEquals(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("accept"), "application/json");
      return Promise.resolve(jsonResponse({ access_token: "gho_test" }));
    }
    if (url.endsWith("/user") && !url.includes("emails")) {
      return Promise.resolve(jsonResponse({
        id: 42,
        login: "octocat",
        name: "The Octocat",
      }));
    }
    if (url.includes("/user/emails")) {
      return Promise.resolve(jsonResponse([
        { email: "other@example.com", primary: false, verified: true },
        { email: "octocat@example.com", primary: true, verified: true },
      ]));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  try {
    const provider = resolveOAuthProvider("github", GITHUB_CREDS);
    const { accessToken } = await provider.exchangeCode("code-1");
    assertEquals(accessToken, "gho_test");
    assertEquals(await provider.fetchIdentity(accessToken), {
      providerUserId: "42",
      email: "octocat@example.com",
      emailVerified: true,
      name: "The Octocat",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const VERIFIED_GITHUB_EMAILS = [
  { email: "octocat@example.com", primary: true, verified: true },
];

function stubGithubIdentityFetch(user: Record<string, unknown>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/user") && !url.includes("emails")) {
      return Promise.resolve(jsonResponse(user));
    }
    if (url.includes("/user/emails")) {
      return Promise.resolve(jsonResponse(VERIFIED_GITHUB_EMAILS));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("github identity accepts a string user id and falls back to login", async () => {
  const restore = stubGithubIdentityFetch({
    id: "node-id",
    login: "octocat",
    name: "   ",
  });
  try {
    const provider = resolveOAuthProvider("github", GITHUB_CREDS);
    assertEquals(await provider.fetchIdentity("gho_test"), {
      providerUserId: "node-id",
      email: "octocat@example.com",
      emailVerified: true,
      name: "octocat",
    });
  } finally {
    restore();
  }
});

test("github identity omits name when name and login are absent", async () => {
  const restore = stubGithubIdentityFetch({ id: 7 });
  try {
    const provider = resolveOAuthProvider("github", GITHUB_CREDS);
    const identity = await provider.fetchIdentity("gho_test");
    assertEquals(identity.providerUserId, "7");
    assertEquals(identity.name, null);
  } finally {
    restore();
  }
});

test("github identity rejects a non-finite numeric user id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/user") && !url.includes("emails")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: Number.NaN, login: "octocat" }),
      } as Response);
    }
    if (url.includes("/user/emails")) {
      return Promise.resolve(jsonResponse(VERIFIED_GITHUB_EMAILS));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  try {
    const provider = resolveOAuthProvider("github", GITHUB_CREDS);
    await assertRejects(
      () => provider.fetchIdentity("gho_test"),
      OAuthProviderError,
      "github identity request returned no user id",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("github identity rejects a missing or empty user id", async () => {
  const provider = resolveOAuthProvider("github", GITHUB_CREDS);
  for (const id of ["", null]) {
    const restore = stubGithubIdentityFetch({ id, login: "octocat" });
    try {
      await assertRejects(
        () => provider.fetchIdentity("gho_test"),
        OAuthProviderError,
        "github identity request returned no user id",
      );
    } finally {
      restore();
    }
  }
});

test("github token exchange maps HTTP errors to OAuthProviderError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse({ error: "bad_verification_code" }, 400));
  try {
    const provider = resolveOAuthProvider("github", GITHUB_CREDS);
    const err = await assertRejects(
      () => provider.exchangeCode("bad"),
      OAuthProviderError,
    );
    assertEquals(err.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("google token exchange and userinfo parse sub/email/name", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Promise.resolve(jsonResponse({ access_token: "ya29.test" }));
    }
    if (url.includes("openidconnect.googleapis.com")) {
      return Promise.resolve(jsonResponse({
        sub: "google-sub",
        email: "ada@example.com",
        email_verified: true,
        name: "Ada Lovelace",
      }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  try {
    const provider = resolveOAuthProvider("google", GOOGLE_CREDS);
    const { accessToken } = await provider.exchangeCode("code-1");
    assertEquals(accessToken, "ya29.test");
    assertEquals(await provider.fetchIdentity(accessToken), {
      providerUserId: "google-sub",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("google identity omits a blank name", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse({
      sub: "sub-1",
      email: "ada@example.com",
      email_verified: true,
      name: "  ",
    }));
  try {
    const provider = resolveOAuthProvider("google", GOOGLE_CREDS);
    const identity = await provider.fetchIdentity("token");
    assertEquals(identity.name, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("google identity without email_verified is treated as unverified", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse({
      sub: "sub-1",
      email: "ada@example.com",
      name: "Ada",
    }));
  try {
    const provider = resolveOAuthProvider("google", GOOGLE_CREDS);
    const identity = await provider.fetchIdentity("token");
    assertEquals(identity.emailVerified, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
