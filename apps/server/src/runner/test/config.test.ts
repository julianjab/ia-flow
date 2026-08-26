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

  it('una carpeta de proyecto trae su definición, sus agentes y sus repos', () => {
    // La forma que agrupa por dominio: todo lo del proyecto X junto, y el
    // projectId sale del nombre de la carpeta sin repetirse en cada archivo.
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': 'settings:\n  daemonMode: polling\n',
        'projects/la-haus-116/project.yaml':
          'name: la-haus-116\nsource:\n  kind: github-projects\n  config:\n    url: https://github.com/orgs/x/projects/1\n',
        'projects/la-haus-116/agents/10-refiner.yaml': `id: refiner\nname: refiner\n${AGENT}`,
        'projects/la-haus-116/repos/backend.yaml': 'name: backend\n',
      }),
    )

    expect(cfg.projects.map((p) => p.id)).toEqual(['la-haus-116'])
    expect(cfg.agents[0]?.projectId).toBe('la-haus-116')
    expect(cfg.repos[0]?.projectId).toBe('la-haus-116')
  })

  it('acepta <id>.yaml además de project.yaml', () => {
    // Es lo que sale natural al mover un archivo suelto adentro de su carpeta.
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': 'settings:\n  daemonMode: polling\n',
        'projects/otro/otro.yaml':
          'name: otro\nsource:\n  kind: github-projects\n  config:\n    url: https://github.com/orgs/x/projects/2\n',
      }),
    )
    expect(cfg.projects.map((p) => p.id)).toEqual(['otro'])
  })

  it('una carpeta sin definición de proyecto tira, y dice qué falta', () => {
    // Sin esto, agrupar archivos en una carpeta cualquiera dentro de projects/
    // los cargaría bajo un projectId que no existe — y el síntoma sería un
    // agente que no dispara nunca.
    expect(() =>
      loadRunnerConfig(
        fixture({
          'runner.yaml': BASE,
          'projects/sin-def/agents/a.yaml': `id: a\nname: a\n${AGENT}`,
        }),
      ),
    ).toThrow(/no tiene 'project\.yaml'/)
  })

  it('los agentes globales van antes que los de un proyecto', () => {
    // Espeja visibleTo, donde un agente con projectId pisa al global del mismo
    // id — y el orden de declaración decide sin `position`.
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': 'settings:\n  daemonMode: polling\n',
        'agents/zz-global.yaml': `id: global\nname: global\n${AGENT}`,
        'projects/aa-proj/project.yaml':
          'name: aa-proj\nsource:\n  kind: github-projects\n  config:\n    url: https://github.com/orgs/x/projects/3\n',
        'projects/aa-proj/agents/uno.yaml': `id: scoped\nname: scoped\n${AGENT}`,
      }),
    )
    expect(cfg.agents.map((a) => a.id)).toEqual(['global', 'scoped'])
    expect(cfg.agents[0]?.projectId).toBeUndefined()
  })

  it('lo que el archivo declara gana sobre la carpeta', () => {
    const cfg = loadRunnerConfig(
      fixture({
        'runner.yaml': 'settings:\n  daemonMode: polling\n',
        'projects/una/project.yaml':
          'name: una\nsource:\n  kind: github-projects\n  config:\n    url: https://github.com/orgs/x/projects/4\n',
        'projects/una/agents/a.yaml': `id: a\nname: a\nprojectId: otro\n${AGENT}`,
      }),
    )
    expect(cfg.agents[0]?.projectId).toBe('otro')
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
