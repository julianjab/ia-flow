import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { TextClassifier } from '@ia-flow/agent-engine'
import { type MountedRunner, mountRunner } from '../boot.js'
import { loadRunnerConfig } from '../config/RunnerConfig.js'
import { memoryDriver } from '../engine/mountEngine.js'

/** La definición real del runner. */
export const CONFIG_DIR = resolve(import.meta.dir, '../../.config')

/** Sin red: cualquier request a GitHub falla, diciendo cuál. */
const offline = (async (input: string | URL | Request) => {
  throw new Error(`test sin red: ${String(input)}`)
}) as unknown as typeof fetch

/** El runner montado sobre `dir` para un test: GitHub sin red (o `githubFetch`), sin MCP y las
 *  ejecuciones en memoria. */
export function mountForTest(
  dir = CONFIG_DIR,
  options: { githubFetch?: typeof fetch; textClassifier?: TextClassifier } = {},
): Promise<MountedRunner> {
  return mountRunner(loadRunnerConfig(dir), {
    log: () => {},
    testing: { githubFetch: options.githubFetch ?? offline, storeDriver: memoryDriver },
    ...(options.textClassifier ? { textClassifier: options.textClassifier } : {}),
  })
}

/** Donde van las copias: DENTRO de la app (`.state/`, gitignoreado), porque las actions de
 *  `.config` importan paquetes y el contrato del runner, y se resuelven desde donde están. */
const COPIES = resolve(import.meta.dir, '../../.state/test-configs')

/** Una copia de `.config`, con `edit` aplicado a sus archivos. */
export function configCopy(edit: Record<string, (content: string) => string> = {}): string {
  mkdirSync(COPIES, { recursive: true })
  const dir = join(mkdtempSync(join(COPIES, 'config-')), '.config')
  cpSync(CONFIG_DIR, dir, { recursive: true })
  for (const [file, change] of Object.entries(edit)) {
    const path = join(dir, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
  }
  return dir
}
