import { Action, type ToolImageMediaType, toolContent } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'

const Input = z.strictObject({
  url: z
    .string()
    .url()
    .describe(
      'La URL de la imagen: un archivo de un repo del proyecto (`https://github.com/<owner>/<repo>/blob/<rama>/<path>`, con o sin `?raw=true`, o `raw.githubusercontent.com`) o una imagen renderizada de Figma',
    ),
})

/** Lo que acepta la API como imagen: base64 hasta 5 MB, o sea ~3,75 MB de bytes. */
export const MAX_IMAGE_BYTES = 3_750_000

/** Las imágenes renderizadas de Figma (`GET /v1/images`): URLs firmadas de S3, sin credencial. */
export const FIGMA_IMAGE_HOSTS = [
  'figma-alpha-api.s3.us-west-2.amazonaws.com',
  's3-alpha-sig.figma.com',
  's3-figma-images-production-sig.figma.com',
]

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export interface ViewImageActionOptions {
  client: GithubClient
  /** Si el runner lee ese repo: los del catálogo de sus proyectos. Otro repo se rechaza. */
  allowRepo: (owner: string, repo: string) => boolean
  /** Hosts fuera de GitHub de los que baja sin credencial. Default: los de Figma. */
  hosts?: string[]
  fetchImpl?: typeof fetch
}

/** Un archivo de GitHub: dueño, repo y lo que sigue a la rama (la rama puede tener `/`). */
interface GithubFile {
  owner: string
  repo: string
  /** `<rama>/<path>`: dónde termina la rama lo resuelve GitHub (`candidates`). */
  rest: string[]
}

/**
 * `view_image`: una imagen como imagen para el modelo, no como link. La baja de un repo del
 * proyecto —con la credencial del runner, así un repo privado también— o de los hosts de Figma, y
 * la devuelve con `toolContent`. Sólo un provider que muestra imágenes (`anthropic-api`) se la
 * enseña al modelo; los demás leen una línea con el tipo y el tamaño.
 */
export class ViewImageAction extends Action<typeof Input> {
  readonly description =
    'Te muestra una imagen (png, jpg, gif o webp): un archivo de un repo del proyecto (una captura del paquete de diseño o de la evidencia de un e2e, por su link de GitHub) o una imagen renderizada de Figma. La ves, no te llega como link.'
  readonly input = Input
  override readonly sideEffects = 'none' as const

  constructor(private readonly options: ViewImageActionOptions) {
    super({ id: 'view_image' })
  }

  async execute(input: z.infer<typeof Input>): Promise<string> {
    const url = new URL(input.url)
    const file = githubFile(url)
    const bytes = file ? await this.fromGithub(file) : await this.fromHost(url)
    const mediaType = sniff(bytes)
    if (!mediaType) {
      throw new Error(
        `view_image: ${input.url} no es png, jpg, gif ni webp (un SVG no se puede ver: pedí su PNG)`,
      )
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `view_image: ${input.url} pesa ${Math.round(bytes.byteLength / 1024)} KB; el tope es ${Math.round(MAX_IMAGE_BYTES / 1024)} KB`,
      )
    }
    return toolContent([
      {
        type: 'text',
        text: `${input.url} (${mediaType}, ${Math.round(bytes.byteLength / 1024)} KB)`,
      },
      { type: 'image', mediaType, data: Buffer.from(bytes).toString('base64') },
    ])
  }

  private async fromGithub(file: GithubFile): Promise<Uint8Array> {
    const { owner, repo } = file
    if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo)) {
      throw new Error(`view_image: owner/repo inválidos: ${owner}/${repo}`)
    }
    if (!this.options.allowRepo(owner, repo)) {
      throw new Error(`view_image: ${owner}/${repo} no es un repo de los proyectos de este runner`)
    }
    // La rama puede tener `/` (`ia-flow/issue-12`): de la más corta a la más larga, la primera que
    // GitHub encuentra. Un 404 es "no era ese corte"; cualquier otro error, el de verdad.
    for (const { ref, path } of candidates(file.rest)) {
      const res = await this.options.client.request(
        `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        { headers: { Accept: 'application/vnd.github.raw' } },
      )
      if (res.status === 404) continue
      if (!res.ok)
        throw new Error(
          `view_image: GitHub respondió ${res.status}: ${(await res.text()).slice(0, 300)}`,
        )
      return new Uint8Array(await res.arrayBuffer())
    }
    throw new Error(`view_image: no existe ${file.rest.join('/')} en ${owner}/${repo}`)
  }

  private async fromHost(url: URL): Promise<Uint8Array> {
    const hosts = this.options.hosts ?? FIGMA_IMAGE_HOSTS
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) {
      throw new Error(
        `view_image: ${url.hostname} no es GitHub ni un host permitido (${hosts.join(', ')})`,
      )
    }
    // Sin seguir redirecciones: una URL permitida no puede llevar a otro host.
    const res = await (this.options.fetchImpl ?? fetch)(url.toString(), { redirect: 'error' })
    if (!res.ok)
      throw new Error(`view_image: ${url.hostname} respondió ${res.status} (¿la URL venció?)`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** El archivo de GitHub de una URL `blob`/`raw` de github.com o de raw.githubusercontent.com. */
function githubFile(url: URL): GithubFile | undefined {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (url.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    const [owner, repo, ...rest] = parts
    return { owner: owner as string, repo: repo as string, rest }
  }
  if (
    url.hostname === 'github.com' &&
    parts.length >= 5 &&
    ['blob', 'raw'].includes(parts[2] as string)
  ) {
    const [owner, repo, , ...rest] = parts
    return { owner: owner as string, repo: repo as string, rest }
  }
  if (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com')) {
    throw new Error(
      `view_image: ${url.toString()} no es un archivo de un repo (un adjunto de un comentario no se puede bajar con la credencial del runner)`,
    )
  }
  return undefined
}

/** Cada forma de partir `<rama>/<path>`, de la rama más corta a la más larga. */
function candidates(rest: string[]): Array<{ ref: string; path: string }> {
  const out: Array<{ ref: string; path: string }> = []
  for (let cut = 1; cut < rest.length && cut <= 6; cut++) {
    out.push({ ref: rest.slice(0, cut).join('/'), path: rest.slice(cut).join('/') })
  }
  return out
}

/** El tipo por los primeros bytes, no por la extensión ni el `content-type`. */
function sniff(bytes: Uint8Array): ToolImageMediaType | undefined {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif'
  const riff = String.fromCharCode(at(0), at(1), at(2), at(3))
  const webp = String.fromCharCode(at(8), at(9), at(10), at(11))
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  return undefined
}
