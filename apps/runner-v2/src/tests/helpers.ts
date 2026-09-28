import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type MountedRunner, mountRunner } from '../boot.js'
import { loadRunnerConfig } from '../config/RunnerConfig.js'

/** La definición real del runner. */
export const CONFIG_DIR = resolve(import.meta.dir, '../../.config')

/** El runner montado en dry-run sobre `dir`: sin red, sin workspace, ejecuciones en memoria. */
export function mountDry(dir = CONFIG_DIR): Promise<MountedRunner> {
  return mountRunner(loadRunnerConfig(dir), { dryRun: true, live: false, log: () => {} })
}

/** Una copia de `.config` en un directorio temporal, con `edit` aplicado a sus archivos. */
export function configCopy(edit: Record<string, (content: string) => string> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'runner-v2-config-')), '.config')
  cpSync(CONFIG_DIR, dir, { recursive: true })
  for (const [file, change] of Object.entries(edit)) {
    const path = join(dir, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
  }
  return dir
}
