// GitHub GraphQL client — thin wrapper around fetch, no extra deps

export interface GQLResponse<T> {
  data: T
  errors?: Array<{ message: string }>
}

export async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = Bun.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not set')

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ia-flow/1.0',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API HTTP ${res.status}: ${text}`)
  }

  const json = (await res.json()) as GQLResponse<T>
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`)
  }

  return json.data
}

// GitHub REST client for simple operations
export async function rest(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const token = Bun.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not set')

  const res = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ia-flow/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub REST ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }

  return res.json()
}
