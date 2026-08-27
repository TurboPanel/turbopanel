import { assertEquals, assertRejects } from '@std/assert'
import {
  fetchGitlabAccount,
  gitlabApiBase,
  gitlabApiHeaders,
  GitlabApiError,
  gitlabGetJson,
  gitlabGetRaw,
  gitlabProjectId,
  listGitlabProjects,
  resolveGitlabCommit,
  toGitlabRepositorySummary,
} from './gitlab-api.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('gitlabApiBase strips trailing slashes once', () => {
  assertEquals(gitlabApiBase('https://gitlab.example.com'), 'https://gitlab.example.com/api/v4')
  assertEquals(
    gitlabApiBase('https://gitlab.example.com/'),
    'https://gitlab.example.com/api/v4',
  )
  assertEquals(
    gitlabApiBase('https://gitlab.example.com///'),
    'https://gitlab.example.com/api/v4',
  )
})

test('gitlabApiHeaders carries a bearer token', () => {
  const headers = gitlabApiHeaders('tok') as Record<string, string>
  assertEquals(headers.authorization, 'Bearer tok')
  assertEquals(headers.accept, 'application/json')
})

test('toGitlabRepositorySummary maps visibility to the private flag', () => {
  assertEquals(
    toGitlabRepositorySummary({
      id: 15,
      path_with_namespace: 'group/app',
      default_branch: 'main',
      visibility: 'private',
      http_url_to_repo: 'https://gitlab.com/group/app.git',
    }),
    {
      id: '15',
      fullName: 'group/app',
      defaultBranch: 'main',
      private: true,
      cloneUrl: 'https://gitlab.com/group/app.git',
    },
  )
  assertEquals(
    toGitlabRepositorySummary({
      id: 16,
      path_with_namespace: 'group/public',
      visibility: 'public',
    })?.private,
    false,
  )
  assertEquals(toGitlabRepositorySummary(null), null)
  assertEquals(toGitlabRepositorySummary({ path_with_namespace: '' }), null)
  assertEquals(
    toGitlabRepositorySummary({ id: '77', path_with_namespace: 'group/string-id' })?.id,
    '77',
  )
  assertEquals(
    toGitlabRepositorySummary({ path_with_namespace: 'group/no-id' })?.id,
    '',
  )
})

test('gitlabProjectId prefers the recorded id and falls back to the clone path', () => {
  assertEquals(gitlabProjectId('42', 'https://gitlab.com/group/app.git'), '42')
  assertEquals(
    gitlabProjectId(null, 'https://gitlab.com/group/sub/app.git'),
    'group/sub/app',
  )
  assertEquals(gitlabProjectId('  ', 'https://gitlab.com/group/app.git'), 'group/app')
  assertEquals(gitlabProjectId(null, 'not-a-url'), null)
})

function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    return Promise.resolve(handler(url, init))
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

test('GitlabApiError records an optional status', () => {
  const error = new GitlabApiError('boom', 403)
  assertEquals(error.name, 'GitlabApiError')
  assertEquals(error.status, 403)
})

test('gitlabGetRaw and gitlabGetJson surface transport vs HTTP outcomes', async () => {
  await withFetch((url) => {
    assertEquals(url, 'https://gitlab.example.com/api/v4/user')
    return new Response('ok', { status: 200 })
  }, async () => {
    const response = await gitlabGetRaw('https://gitlab.example.com', 'tok', '/user')
    assertEquals(response.ok, true)
  })

  await withFetch(() => new Response('missing', { status: 404 }), async () => {
    assertEquals(await gitlabGetJson('https://gitlab.example.com', 'tok', '/user'), {
      ok: false,
      status: 404,
    })
  })

  await withFetch(() => new Response(JSON.stringify({ id: 1 }), { status: 200 }), async () => {
    assertEquals(await gitlabGetJson('https://gitlab.example.com', 'tok', '/user'), {
      ok: true,
      payload: { id: 1 },
    })
  })

  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('reset'))) as typeof fetch
  try {
    await assertRejects(
      () => gitlabGetRaw('https://gitlab.example.com', 'tok', '/user'),
      GitlabApiError,
      'gitlab request failed: reset',
    )
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (() => Promise.reject('offline')) as typeof fetch
  try {
    await assertRejects(
      () => gitlabGetRaw('https://gitlab.example.com', 'tok', '/user'),
      GitlabApiError,
      'gitlab request failed: network error',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('listGitlabProjects walks pages and skips malformed entries', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    path_with_namespace: `group/app-${index + 1}`,
    visibility: 'public',
    http_url_to_repo: `https://gitlab.example.com/group/app-${index + 1}.git`,
  }))
  await withFetch((url) => {
    // Match the GitLab `page=` query, not the `per_page=100` substring.
    const page = new URL(url).searchParams.get('page')
    if (page === '1') {
      return new Response(JSON.stringify([...firstPage, { id: 0 }]), { status: 200 })
    }
    if (page === '2') {
      return new Response(
        JSON.stringify([
          { id: 101, path_with_namespace: 'group/last', visibility: 'internal' },
          { path_with_namespace: '' },
        ]),
        { status: 200 },
      )
    }
    throw new TypeError(`unexpected page ${url}`)
  }, async () => {
    const projects = await listGitlabProjects('https://gitlab.example.com', 'tok')
    assertEquals(projects.length, 101)
    assertEquals(projects[0]?.fullName, 'group/app-1')
    assertEquals(projects.at(-1), {
      id: '101',
      fullName: 'group/last',
      defaultBranch: null,
      private: true,
      cloneUrl: null,
    })
  })
})

test('listGitlabProjects treats a non-array payload as an empty page', async () => {
  await withFetch(() => new Response(JSON.stringify({ projects: [] }), { status: 200 }), async () => {
    assertEquals(await listGitlabProjects('https://gitlab.example.com', 'tok'), [])
  })
})

test('gitlab JSON errors prefer message then error then status-only', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ message: 'token expired' }), { status: 401 }),
    async () => {
      await assertRejects(
        () => listGitlabProjects('https://gitlab.example.com', 'tok'),
        GitlabApiError,
        'gitlab request failed (401): token expired',
      )
    },
  )
  await withFetch(
    () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    async () => {
      await assertRejects(
        () => listGitlabProjects('https://gitlab.example.com', 'tok'),
        GitlabApiError,
        'gitlab request failed (403): forbidden',
      )
    },
  )
  await withFetch(() => new Response('', { status: 502 }), async () => {
    await assertRejects(
      () => listGitlabProjects('https://gitlab.example.com', 'tok'),
      GitlabApiError,
      'gitlab request failed (502)',
    )
  })
  await withFetch(() => new Response('upstream html', { status: 502 }), async () => {
    await assertRejects(
      () => listGitlabProjects('https://gitlab.example.com', 'tok'),
      GitlabApiError,
      'gitlab request failed (502)',
    )
  })
})

test('fetchGitlabAccount maps the connected user and degrades on failure', async () => {
  await withFetch(() => new Response(JSON.stringify({ id: 7, username: 'ada' }), { status: 200 }), async () => {
    assertEquals(await fetchGitlabAccount('https://gitlab.example.com', 'tok'), {
      externalId: '7',
      login: 'ada',
    })
  })
  await withFetch(
    () => new Response(JSON.stringify({ id: '9', username: 12 }), { status: 200 }),
    async () => {
      assertEquals(await fetchGitlabAccount('https://gitlab.example.com', 'tok'), {
        externalId: '9',
        login: null,
      })
    },
  )
  await withFetch(() => new Response(JSON.stringify(['not-an-object']), { status: 200 }), async () => {
    assertEquals(await fetchGitlabAccount('https://gitlab.example.com', 'tok'), {
      externalId: null,
      login: null,
    })
  })
  await withFetch(() => new Response('nope', { status: 401 }), async () => {
    assertEquals(await fetchGitlabAccount('https://gitlab.example.com', 'tok'), {
      externalId: null,
      login: null,
    })
  })
})

test('resolveGitlabCommit prefers title and keeps author when present', async () => {
  await withFetch((url) => {
    assertEquals(
      url.includes('/projects/group%2Fapp/repository/commits/main'),
      true,
    )
    return new Response(
      JSON.stringify({
        id: 'abc123',
        title: 'feat: ship\n\nbody',
        message: 'ignored',
        author_name: '  Ada  ',
      }),
      { status: 200 },
    )
  }, async () => {
    assertEquals(
      await resolveGitlabCommit('https://gitlab.example.com', 'tok', 'group/app', 'main'),
      {
        commitSha: 'abc123',
        commitMessage: 'feat: ship',
        commitAuthor: 'Ada',
      },
    )
  })
})

test('resolveGitlabCommit falls back to message and rejects incomplete payloads', async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ id: 'def', message: 'only message' }), { status: 200 }),
    async () => {
      assertEquals(
        await resolveGitlabCommit('https://gitlab.example.com', 'tok', '15', 'main'),
        { commitSha: 'def', commitMessage: 'only message' },
      )
    },
  )
  await withFetch(() => new Response('not-json', { status: 200 }), async () => {
    await assertRejects(
      () => resolveGitlabCommit('https://gitlab.example.com', 'tok', '15', 'main'),
      GitlabApiError,
      'returned no commit',
    )
  })
  await withFetch(() => new Response(JSON.stringify({ id: '' }), { status: 200 }), async () => {
    await assertRejects(
      () => resolveGitlabCommit('https://gitlab.example.com', 'tok', '15', 'main'),
      GitlabApiError,
      'returned no sha',
    )
  })
})
