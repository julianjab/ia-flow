import { describe, expect, it } from 'bun:test'
import type { Rule } from '@ia-flow/shared'
import { YamlRuleRepository } from '../YamlRuleRepository.js'

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    on: ['issue.scanned'],
    do: [{ action: 'agent', agentId: 'refiner' }],
    ...over,
  }
}

describe('YamlRuleRepository', () => {
  it('valida el contenido contra RuleSchema al construirse', () => {
    // El repositorio es el borde que garantiza que lo que sale cumple el
    // contrato: un YAML mal escrito falla al bootear, no en el primer evento.
    expect(() => new YamlRuleRepository([{ id: 'x' }])).toThrow()
  })

  it('ordena por posición y desempata por id, igual que SQLite', () => {
    // Los dos backings tienen que darle al matcher la misma prioridad.
    const repo = new YamlRuleRepository([
      rule({ id: 'z', position: 1 }),
      rule({ id: 'a', position: 1 }),
      rule({ id: 'first', position: 0 }),
    ])
    expect(repo.list().then((r) => r.map((x) => x.id))).resolves.toEqual(['first', 'a', 'z'])
  })

  it('visibleTo suma las globales a las del proyecto', async () => {
    const repo = new YamlRuleRepository([
      rule({ id: 'global' }),
      rule({ id: 'p1', projectId: 'p1' }),
      rule({ id: 'p2', projectId: 'p2' }),
    ])
    expect((await repo.visibleTo('p1')).map((r) => r.id)).toEqual(['global', 'p1'])
  })

  it('sin projectId devuelve SÓLO las globales — fail-closed', async () => {
    // Mismo criterio que el repo SQLite: un evento sin scope no puede ver las
    // reglas de todos los proyectos a la vez.
    const repo = new YamlRuleRepository([
      rule({ id: 'global' }),
      rule({ id: 'p1', projectId: 'p1' }),
    ])
    expect((await repo.visibleTo()).map((r) => r.id)).toEqual(['global'])
  })

  it('las escrituras tiran — el archivo es la fuente', async () => {
    // Un operador que cree que guardó una regla y no la guardó es el fallo
    // silencioso que este modelo trata de eliminar.
    const repo = new YamlRuleRepository([rule()])
    expect(repo.isReadOnly()).toBe(true)
    expect(repo.upsert()).rejects.toThrow('sólo lectura')
    expect(repo.deleteById()).rejects.toThrow('sólo lectura')
    expect(repo.setPositions()).rejects.toThrow('sólo lectura')
  })

  // Un runner.yaml de deploy headless no pasa por la migración 080 (sólo
  // reescribe SQLite) — sin esto, una regla con `on: ['pr.merged']` quedaría
  // callada para siempre, sin ningún error.
  it('traduce en memoria una regla que usa la taxonomía vieja de GitHub', async () => {
    const repo = new YamlRuleRepository([rule({ id: 'legacy', on: ['pr.merged'] })])
    const [migrated] = await repo.list()
    expect(migrated.on).toEqual(['pull_request'])
    expect(migrated.when).toEqual([
      { field: 'action', op: '=', value: 'closed' },
      { field: 'pr.merged', op: '=', value: 'true' },
    ])
  })

  it('una regla en nombre crudo, o sin taxonomía vieja, no se toca', async () => {
    const repo = new YamlRuleRepository([rule({ id: 'raw', on: ['issue_comment'] })])
    const [r] = await repo.list()
    expect(r.on).toEqual(['issue_comment'])
    expect(r.when).toBeUndefined()
  })

  // Mezclar un tipo curado con uno no-curado no es auto-traducible (ver
  // legacy-event-rename.ts) — la regla queda con el `on` viejo, que ya no
  // matchea nada de GitHub, pero al menos no se rompe el boot.
  it('una mezcla ambigua no se traduce — queda con el on viejo', async () => {
    const repo = new YamlRuleRepository([
      rule({ id: 'mixed', on: ['issue.status_changed', 'pr.review_submitted'] }),
    ])
    const [r] = await repo.list()
    expect(r.on).toEqual(['issue.status_changed', 'pr.review_submitted'])
  })
})
