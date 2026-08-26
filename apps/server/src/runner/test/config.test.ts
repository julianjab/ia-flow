import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRunnerConfig } from '../config.js'

const AGENT = 'provider: anthropic-api\nprompt: hace algo\n'
const BASE = `settings:
  daemonMode: polling
projects:
  - id: inline-project
    name: inline-project
    source:
      kind: github-projects
      config:
        url: https://github.com/orgs/x/projects/1
`

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function fixture(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'ia-flow-runner-'))
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return join(dir, 'runner.yaml')
}

describe('loadRunnerConfig — carpetas por sección', () => {
  it('sin carpetas se comporta como siempre', () => {
    const cfg = loadRunnerConfig(fixture({ 'runner.yaml': BASE }))
    expect(cfg.projects.map((p) => p.id)).toEqual(['inline-project'])
    expect(cfg.agents).toEqual([])
  })

  it('tira si no hay ningún proyecto, ni inline ni en la carpeta', () => {
    // El chequeo vive acá y no en el schema porque los proyectos pueden venir
    // enteros de `projects/`. El mensaje nombra los DOS lugares: un runner sin
    // fuente no tiene qué escanear, y hay que saber dónde mirar.
    expect(() =>
      loadRunnerConfig(fixture({ 'runner.yaml': 'settings:\n  daemonMode: polling\n' })),
    ).toThrow(/no declara ningún proyecto/)
  })

  it('suma agents/, repos/ y projects/ a lo declarado inline', () => {
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': `${BASE}agents:\n  - id: inline-agent\n    name: inline-agent\n    ${AGENT.replace('\n', '\n    ')}`,
        'agents/10-refiner.yaml': `id: refiner\nname: refiner\n${AGENT}`,
        'repos/subs.yaml': 'name: subscriptions\nprojectId: inline-project\n',
        'projects/board.yaml':
          'id: board-119\nname: board-119\nsource:\n  kind: github-projects\n  config:\n    url: https://github.com/orgs/la-haus/projects/119\n',
      }),
    )

    expect(cfg.agents.map((a) => a.id)).toEqual(['inline-agent', 'refiner'])
    expect(cfg.repos.map((r) => r.name)).toEqual(['subscriptions'])
    expect(cfg.projects.map((p) => p.id)).toEqual(['inline-project', 'board-119'])
  })

  it('lee los archivos en orden alfabético, no en el del filesystem', () => {
    // De este orden depende cuál agente gana cuando ninguno declara
    // `position`: selectAgent corre "el primero por position" y cae al orden
    // de declaración. Sin el sort explícito, el mismo roster se comportaría
    // distinto en dos máquinas.
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': BASE,
        'agents/30-c.yaml': `id: c\nname: c\n${AGENT}`,
        'agents/10-a.yaml': `id: a\nname: a\n${AGENT}`,
        'agents/20-b.yaml': `id: b\nname: b\n${AGENT}`,
      }),
    )
    expect(cfg.agents.map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('un archivo puede traer una lista, y se expande en su lugar', () => {
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': BASE,
        'agents/10-par.yaml': `- id: uno\n  name: uno\n  ${AGENT.replace('\n', '\n  ')}\n- id: dos\n  name: dos\n  ${AGENT.replace('\n', '\n  ')}`,
        'agents/20-tres.yaml': `id: tres\nname: tres\n${AGENT}`,
      }),
    )
    expect(cfg.agents.map((a) => a.id)).toEqual(['uno', 'dos', 'tres'])
  })

  it('ignora lo que no sea .yaml/.yml', () => {
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': BASE,
        'agents/README.md': '# no soy un agente',
        'agents/a.yaml': `id: a\nname: a\n${AGENT}`,
      }),
    )
    expect(cfg.agents.map((a) => a.id)).toEqual(['a'])
  })

  it('un archivo inválido tira nombrando el archivo, no la sección entera', () => {
    expect(() =>
      loadRunnerConfig(
        fixture({
          'runner.yaml': BASE,
          'agents/roto.yaml': 'id: roto\nname: roto\n', // sin provider ni prompt
        }),
      ),
    ).toThrow(/roto\.yaml/)
  })
})
