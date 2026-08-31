import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServerLogsRouter } from '../server-logs.js'

// `resolveLogDir()` lee IA_FLOW_LOG_DIR en CADA llamada, así que apuntarla a
// un temp dir por test alcanza — no hace falta subproceso como en el probe del
// logger (ahí lo que se fija al importar es el sink de escritura, no éste).
const original = Bun.env.IA_FLOW_LOG_DIR
const dirs: string[] = []

function logDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-flow-logs-route-'))
  dirs.push(dir)
  Bun.env.IA_FLOW_LOG_DIR = dir
  return dir
}

function line(time: string, msg: string): string {
  return `${JSON.stringify({ level: 30, time, module: 'probe', msg })}\n`
}

// `?sort=asc` porque el default de la ruta es descendente (lo más nuevo
// arriba, que es lo que la UI quiere) y acá lo que se afirma es el orden en
// que se concatenaron los archivos.
async function fetchEntries(query = '?sort=asc'): Promise<Array<{ msg: string; time: string }>> {
  const res = await createServerLogsRouter().request(`/${query}`)
  const body = (await res.json()) as { entries: Array<{ msg: string; time: string }> }
  return body.entries
}

afterEach(() => {
  if (original === undefined) delete Bun.env.IA_FLOW_LOG_DIR
  else Bun.env.IA_FLOW_LOG_DIR = original
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/server-logs — ventana a través de la rotación', () => {
  test('la historia no se corta cuando el archivo activo recién rotó', async () => {
    // El escenario que rompía: pino-roll rota a los 50 MB y `daemon.2.log`
    // arranca casi vacío. Leyendo sólo el activo, la UI quedaba en blanco con
    // los últimos minutos intactos en `daemon.1.log`.
    const dir = logDir()
    writeFileSync(
      join(dir, 'daemon.1.log'),
      line('2026-08-27T10:00:00.000Z', 'viejo-1') + line('2026-08-27T10:00:01.000Z', 'viejo-2'),
    )
    writeFileSync(join(dir, 'daemon.2.log'), line('2026-08-27T10:00:02.000Z', 'recien-rotado'))

    const entries = await fetchEntries()

    // Los dos archivos, y en orden cronológico: la ruta arma `entries` en
    // orden de lectura y pagina sobre eso, así que concatenar al revés
    // rompería la paginación en silencio.
    expect(entries.map((e) => e.msg)).toEqual(['viejo-1', 'viejo-2', 'recien-rotado'])
  })

  test('el número de rotación ordena, no el mtime', async () => {
    // Un touch o un rsync sobre un rotado viejo no debe redirigir la lectura
    // ni reordenar la ventana.
    const dir = logDir()
    writeFileSync(join(dir, 'daemon.9.log'), line('2026-08-27T10:00:09.000Z', 'n-9'))
    writeFileSync(join(dir, 'daemon.10.log'), line('2026-08-27T10:00:10.000Z', 'n-10'))
    // Escrito último, pero es el más viejo por número: va primero igual.
    writeFileSync(join(dir, 'daemon.2.log'), line('2026-08-27T10:00:02.000Z', 'n-2'))

    const entries = await fetchEntries()

    expect(entries.map((e) => e.msg)).toEqual(['n-2', 'n-9', 'n-10'])
  })

  test('el daemon.log legado se lee, y cuenta como el más viejo', async () => {
    // Lo que dejó cualquier instalación previa a la rotación. Sin esto, el
    // primer arranque con el sink nuevo dejaba toda la historia invisible.
    const dir = logDir()
    writeFileSync(join(dir, 'daemon.log'), line('2026-08-27T09:00:00.000Z', 'pre-rotacion'))
    writeFileSync(join(dir, 'daemon.1.log'), line('2026-08-27T10:00:00.000Z', 'post-rotacion'))

    const entries = await fetchEntries()

    expect(entries.map((e) => e.msg)).toEqual(['pre-rotacion', 'post-rotacion'])
  })

  test('un directorio sin logs devuelve vacío, no un error', async () => {
    logDir()
    const res = await createServerLogsRouter().request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: unknown[]; total: number }
    expect(body.entries).toEqual([])
    expect(body.total).toBe(0)
  })
})

// Filtrar por `extras`: quién escribió la línea (agente), sobre qué (tarea,
// proyecto) y de qué corrida. `projectId` estaba en el schema desde siempre pero
// la ruta nunca lo leía — era un filtro que se aceptaba y no filtraba.
describe('GET /api/server-logs — filtros sobre extras', () => {
  function extraLine(msg: string, extras: Record<string, string>): string {
    return `${JSON.stringify({ level: 30, time: '2026-08-27T10:00:00.000Z', module: 'engine', msg, ...extras })}\n`
  }

  function seed(): void {
    const dir = logDir()
    writeFileSync(
      join(dir, 'daemon.log'),
      extraLine('refiner en la 12', { agentId: 'refiner', taskId: 't-12', projectId: 'p1' }) +
        extraLine('builder en la 12', { agentId: 'builder', taskId: 't-12', projectId: 'p1' }) +
        extraLine('refiner en la 99', { agentId: 'refiner', taskId: 't-99', projectId: 'p2' }) +
        extraLine('migración', {}),
    )
  }

  test('filtra por agente', async () => {
    seed()
    const entries = await fetchEntries('?sort=asc&agentId=refiner')
    expect(entries.map((e) => e.msg)).toEqual(['refiner en la 12', 'refiner en la 99'])
  })

  test('filtra por tarea, y dos valores del mismo campo se suman', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&taskId=t-99')).map((e) => e.msg)).toEqual([
      'refiner en la 99',
    ])
    expect(
      (await fetchEntries('?sort=asc&taskId=t-12&taskId=t-99')).map((e) => e.msg),
    ).toHaveLength(3)
  })

  test('filtra por proyecto — el campo que el schema aceptaba sin filtrar', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&projectId=p2')).map((e) => e.msg)).toEqual([
      'refiner en la 99',
    ])
  })

  // Dos campos distintos son un AND: "de este agente Y sobre esta tarea".
  test('dos campos distintos se intersectan', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&agentId=refiner&taskId=t-12')).map((e) => e.msg)).toEqual(
      ['refiner en la 12'],
    )
  })

  // La infraestructura no pertenece a ningún agente: preguntar por uno es pedir
  // explícitamente lo que sí tiene dueño.
  test('una línea sin el campo queda afuera', async () => {
    seed()
    const msgs = (await fetchEntries('?sort=asc&agentId=refiner')).map((e) => e.msg)
    expect(msgs).not.toContain('migración')
  })

  // Un query mal armado no puede vaciar el listado en silencio.
  test('un valor vacío no filtra nada', async () => {
    seed()
    expect(await fetchEntries('?sort=asc&agentId=')).toHaveLength(4)
  })
})
