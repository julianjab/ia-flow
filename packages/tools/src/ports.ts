// Shared mutable slots for ports que más de un módulo de este paquete
// consume, wireados una vez por el composition root de cada app
// (apps/server/src/composition/container.ts y
// apps/ai-provider-gateway/src/providers.ts).
import type { SystemPromptPort } from './contract.js'

let systemPromptPort: SystemPromptPort | null = null

export function setSystemPromptPort(port: SystemPromptPort | null): void {
  systemPromptPort = port
}

export function getSystemPromptPort(): SystemPromptPort | null {
  return systemPromptPort
}

/**
 * Resuelve la credencial de GitHub con la que `bash_run` autentica los
 * comandos de red de git (`fetch`, `push`).
 *
 * Es una FUNCIÓN, no un string, por la misma razón que el `githubToken` de
 * `WorkspaceManager`: en modo `github-app` el installation token vive ~1h y
 * el daemon vive días, así que capturarlo al arrancar da 403 en silencio a
 * los 60 minutos. Se llama en cada `bash_run`, no una vez.
 *
 * Sin wirear, `bash_run` no inyecta nada y git queda como estaba: funciona
 * donde la máquina tenga credenciales ambientales (un dev con el helper de
 * osxkeychain o de `gh`) y falla donde no las haya (un contenedor).
 */
export type GitTokenPort = () => Promise<string | undefined>

let gitTokenPort: GitTokenPort | null = null

export function setGitTokenPort(port: GitTokenPort | null): void {
  gitTokenPort = port
}

export function getGitTokenPort(): GitTokenPort | null {
  return gitTokenPort
}
