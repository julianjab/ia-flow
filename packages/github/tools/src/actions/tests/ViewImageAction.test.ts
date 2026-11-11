import {
  createEvent,
  EventBus,
  type PipelineExecutionContext,
  parseToolContent,
} from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_BYTES, ViewImageAction } from '../ViewImageAction.js'

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('e', {}),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'p',
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** GitHub con un solo archivo: `ref` + `path`. Lo demás, 404. */
function fakeGithub(files: Record<string, Uint8Array>) {
  const urls: string[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    urls.push(url)
    const { pathname, searchParams } = new URL(url)
    const key = `${searchParams.get('ref')}:${decodeURIComponent(pathname)}`
    const accept = new Headers(init.headers).get('accept')
    const body = files[key]
    if (!body || accept !== 'application/vnd.github.raw') return new Response('{}', { status: 404 })
    return new Response(Buffer.from(body), { status: 200 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('ghs_runner'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, urls }
}

const allowLaHaus = (owner: string, repo: string) => owner === 'la-haus' && repo === 'ai-mobile-app'

describe('ViewImageAction', () => {
  it('baja una captura de una rama con `/` y la devuelve como imagen', async () => {
    const { client, urls } = fakeGithub({
      'ia-flow/issue-12:/repos/la-haus/ai-mobile-app/contents/design/baseline/lista@mobile.png':
        PNG,
    })
    const out = await new ViewImageAction({ client, allowRepo: allowLaHaus }).run(ctx(), {
      url: 'https://github.com/la-haus/ai-mobile-app/blob/ia-flow/issue-12/design/baseline/lista@mobile.png?raw=true',
    })
    const blocks = parseToolContent(out as string)
    expect(blocks?.[1]).toEqual({
      type: 'image',
      mediaType: 'image/png',
      data: Buffer.from(PNG).toString('base64'),
    })
    // Primero probó la rama `ia-flow` (404), después `ia-flow/issue-12`.
    expect(urls).toHaveLength(2)
  })

  it('rechaza un repo que no es de los proyectos', async () => {
    const { client } = fakeGithub({})
    await expect(
      new ViewImageAction({ client, allowRepo: allowLaHaus }).run(ctx(), {
        url: 'https://github.com/otro/repo/blob/main/x.png',
      }),
    ).rejects.toThrow('no es un repo de los proyectos')
  })

  it('rechaza un host que no es GitHub ni Figma', async () => {
    const { client } = fakeGithub({})
    await expect(
      new ViewImageAction({ client, allowRepo: allowLaHaus }).run(ctx(), {
        url: 'https://169.254.169.254/latest/meta-data',
      }),
    ).rejects.toThrow('no es GitHub ni un host permitido')
  })

  it('baja una imagen renderizada de Figma sin credencial y sin seguir redirecciones', async () => {
    const { client } = fakeGithub({})
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('authorization')).toBeNull()
      return new Response(Buffer.from(PNG), { status: 200 })
    })
    const out = await new ViewImageAction({
      client,
      allowRepo: allowLaHaus,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).run(ctx(), { url: 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc' })
    expect(parseToolContent(out as string)?.[1]).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
    })
  })

  it('rechaza un SVG y una imagen que pasa el tope', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    big.set(PNG)
    const { client } = fakeGithub({
      'main:/repos/la-haus/ai-mobile-app/contents/a.svg': svg,
      'main:/repos/la-haus/ai-mobile-app/contents/big.png': big,
    })
    const action = new ViewImageAction({ client, allowRepo: allowLaHaus })
    await expect(
      action.run(ctx(), { url: 'https://github.com/la-haus/ai-mobile-app/blob/main/a.svg' }),
    ).rejects.toThrow('un SVG no se puede ver')
    await expect(
      action.run(ctx(), {
        url: 'https://raw.githubusercontent.com/la-haus/ai-mobile-app/main/big.png',
      }),
    ).rejects.toThrow('el tope es')
  })
})
