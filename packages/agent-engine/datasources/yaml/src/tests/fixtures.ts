import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Catalogs, DefinitionPipelineSource } from '@ia-flow/agent-engine-definitions'
import { YamlDefinitionSource, type YamlDefinitionSourceOptions } from '../YamlDefinitionSource.js'

/** Una carpeta de YAML traducida (este paquete) y armada (`agent-engine-definitions`): lo que el
 *  engine ve de ella. */
export function yamlSource(
  options: YamlDefinitionSourceOptions & { catalogs?: Catalogs },
): DefinitionPipelineSource {
  const { catalogs, ...datasource } = options
  return new DefinitionPipelineSource(new YamlDefinitionSource(datasource), catalogs)
}

/** Una carpeta temporal con estos archivos (ruta relativa → contenido). */
export function sourceDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-engine-yaml-'))
  writeFiles(dir, files)
  return dir
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

/** El gate de CI: el implementer termina, se asegura el PR y espera el CI; verde → review. */
export const CI_GATE = {
  'source.yaml': `
id: flow
onError:
  to: [{ action: addLabel, with: { label: blocked } }]
`,
  'agents/implementer.yaml': `
id: implementer
provider: done
prompt: "Implementá el issue #{{issue}}"
routes:
  done:
    when: El PR está listo
    to: [{ action: ensurePr }, { pause: wait-ci, branches: { green: { on: [check_suite], when: [{ field: conclusion, op: eq, value: success }], to: [{ function: review }] } } }]
`,
  'pipelines/build.yaml': `
id: build
on: [build]
do:
  - { agent: implementer }
`,
}
