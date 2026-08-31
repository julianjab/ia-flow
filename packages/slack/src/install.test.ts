import { afterEach, describe, expect, it } from 'bun:test'
import type { IRepoRepository } from '@ia-flow/agent-engine'
import type { ProjectSource } from '@ia-flow/issue-sources'
import { getTool } from '@ia-flow/tools'
import { installSlack } from './install.js'
import { SLACK_REVIEW_TOOL } from './review-tool.js'
import { SLACK_TOOL_NAMES } from './tools.js'

// Lo que se verifica acá es la promesa del paquete: **sin credencial no hay
// tools**. El editor de agentes lista el registry, así que una tool registrada
// por un proceso que no puede hablar con Slack es una que se puede tildar y
// siempre falla.

const ORIGINAL = Bun.env.SLACK_BOT_TOKEN

function setToken(value: string | undefined) {
  if (value === undefined) delete Bun.env.SLACK_BOT_TOKEN
  else Bun.env.SLACK_BOT_TOKEN = value
}

const repoRepo = { getByProject: () => undefined } as unknown as IRepoRepository
const projectRepo = { get: () => null }
const runtime = {
  resolveProjectId: () => undefined,
  getSource: () => ({}) as ProjectSource,
}

function registered(): string[] {
  return [...SLACK_TOOL_NAMES, SLACK_REVIEW_TOOL].filter((name) => getTool(name) !== undefined)
}

afterEach(() => {
  setToken(ORIGINAL)
  // El registry es del proceso: lo que registre un test lo ve el siguiente.
  installSlack({ repoRepo, projectRepo, runtime }).sync()
})

describe('installSlack', () => {
  it('sin token no registra ninguna tool', () => {
    setToken(undefined)
    const slack = installSlack({ repoRepo, projectRepo, runtime })
    expect(slack.enabled).toBe(false)
    expect(registered()).toEqual([])
  })

  it('con token registra las cinco', () => {
    setToken('xoxb-1')
    const slack = installSlack({ repoRepo, projectRepo, runtime })
    expect(slack.enabled).toBe(true)
    expect(registered()).toEqual([...SLACK_TOOL_NAMES, SLACK_REVIEW_TOOL])
  })

  it('sin runtime no ofrece el pedido de review: no tendría cómo resolver la tarea', () => {
    setToken('xoxb-1')
    installSlack({ repoRepo, projectRepo })
    expect(registered()).toEqual([...SLACK_TOOL_NAMES])
  })

  it('sync() sigue al token en las dos direcciones, sin reiniciar', () => {
    setToken(undefined)
    const slack = installSlack({ repoRepo, projectRepo, runtime })
    expect(registered()).toEqual([])

    // El operador pega el token en Configuración.
    setToken('xoxb-1')
    slack.sync()
    expect(registered()).toEqual([...SLACK_TOOL_NAMES, SLACK_REVIEW_TOOL])

    // …y lo borra.
    setToken(undefined)
    slack.sync()
    expect(registered()).toEqual([])
  })

  it('las piezas que el server consume como valores existen aunque esté apagado', () => {
    setToken(undefined)
    const slack = installSlack({ repoRepo, projectRepo, runtime })
    expect(slack.translator.handles('event_callback')).toBe(true)
    expect(slack.directory).toBeDefined()
    expect(slack.reviewUseCase).toBeDefined()
  })
})
