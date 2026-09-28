/**
 * La identidad de GitHub del runner, desde `IA_FLOW_GITHUB_*` (lo que `applyRunnerEnv` dejó en el
 * env): la App si están los tres datos, si no `GITHUB_TOKEN`, si no `gh auth token`. Se verifica
 * ANTES de montar nada: un runner que no puede hablar con GitHub no arranca.
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { GithubAppAuth, type GithubAuth, GithubTokenAuth } from '@ia-tools/github-auth'

export interface ResolvedGithubAuth {
  auth: GithubAuth
  mode: string
  /** Con la App: qué App, qué instalación y qué PEM (con su fingerprint). */
  detail?: string
}

function expandHome(path: string): string {
  return path.startsWith('~') ? path.replace('~', homedir()) : path
}

/** El fingerprint que GitHub muestra en la App (Settings → Private keys): SHA256 de la clave
 *  pública en DER, en base64. Sirve para confirmar que el PEM local es de ESA App. */
function pemFingerprint(privateKey: string): string {
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`
}

export async function resolveGithubAuth(env = process.env): Promise<ResolvedGithubAuth> {
  const mode = env.IA_FLOW_GITHUB_AUTH_MODE ?? 'auto'
  const appId = env.IA_FLOW_GITHUB_APP_ID
  const installationId = env.IA_FLOW_GITHUB_APP_INSTALLATION_ID
  const pemPath = env.IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH

  const app = async () => {
    if (!appId || !installationId || !pemPath) {
      throw new Error(
        'github.mode=github-app pero falta appId, installationId o la ruta del PEM (IA_FLOW_GITHUB_APP_*)',
      )
    }
    let privateKey: string
    try {
      privateKey = await readFile(expandHome(pemPath), 'utf-8')
    } catch {
      throw new Error(
        `No se pudo leer el PEM en '${pemPath}' — apuntalo con IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH`,
      )
    }
    const detail = `appId ${appId}, installation ${installationId}, PEM ${pemPath} (${pemFingerprint(privateKey)})`
    return { auth: new GithubAppAuth({ appId, installationId, privateKey }), detail }
  }
  const staticToken = () => {
    if (!env.GITHUB_TOKEN) throw new Error('github.mode=static pero GITHUB_TOKEN no está seteado')
    return new GithubTokenAuth(env.GITHUB_TOKEN)
  }
  const ghCli = () =>
    new GithubTokenAuth(execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8' }).trim())

  switch (mode) {
    case 'github-app':
      return { ...(await app()), mode }
    case 'static':
      return { auth: staticToken(), mode }
    case 'gh-cli':
      return { auth: ghCli(), mode }
    default:
      if (appId && installationId && pemPath) return { ...(await app()), mode: 'auto→github-app' }
      if (env.GITHUB_TOKEN) return { auth: staticToken(), mode: 'auto→static' }
      return { auth: ghCli(), mode: 'auto→gh-cli' }
  }
}

/** Pide un token para confirmar la identidad; si falla, explica qué mirar. */
export async function verifyGithubAuth(resolved: ResolvedGithubAuth): Promise<void> {
  try {
    await resolved.auth.getToken()
  } catch (err) {
    const hint = resolved.detail
      ? `\n  ${resolved.detail}\n  "could not be decoded" = GitHub no pudo verificar el JWT con la clave pública de esa App: el PEM es de otra App o fue revocado. Compará el fingerprint con el de la App en GitHub (Settings → Developer settings → GitHub Apps → la App → Private keys).`
      : ''
    throw new Error(
      `GitHub: no se pudo obtener un token (${resolved.mode}): ${(err as Error).message}${hint}`,
    )
  }
}
