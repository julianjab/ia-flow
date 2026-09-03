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
      extraLine('refiner en la 12', {
        agentId: 'refiner',
        taskId: 't-12',
        projectId: 'p1',
        task: 'Arreglar el bug de dedupe',
      }) +
        extraLine('builder en la 12', { agentId: 'builder', taskId: 't-12', projectId: 'p1' }) +
        extraLine('refiner en la 99', { agentId: 'refiner', taskId: 't-99', projectId: 'p2' }) +
        extraLine('script de la regla', { ruleId: 'ia-flow-refine' }) +
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

  // Una ACCIÓN no tiene `runId` —no es un run del agente—, así que la regla es
  // lo único que correlaciona sus líneas.
  test('filtra por regla', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&ruleId=ia-flow-refine')).map((e) => e.msg)).toEqual([
      'script de la regla',
    ])
  })

  // `task` es el título — sólo lo estampa el camino sync, al lado del `taskId`
  // opaco. Mismo predicado de `extras`, sin traducir nada.
  test('filtra por título de tarea', async () => {
    seed()
    expect(
      (await fetchEntries(`?sort=asc&task=${encodeURIComponent('Arreglar el bug de dedupe')}`)).map(
        (e) => e.msg,
      ),
    ).toEqual(['refiner en la 12'])
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
    expect(await fetchEntries('?sort=asc&agentId=')).toHaveLength(5)
  })
})

// `extra` es un patrón GLOB (*/?), no una regexp arbitraria — ver el
// comentario de `globMatchFull` en server-logs.ts sobre por qué (ReDoS: corre
// en el event loop del daemon, sobre potencialmente decenas de miles de
// líneas por request).
describe('GET /api/server-logs — extra:<clave>:<patrón>', () => {
  function extraLine(msg: string, extras: Record<string, unknown>): string {
    return `${JSON.stringify({ level: 30, time: '2026-08-27T10:00:00.000Z', module: 'engine', msg, ...extras })}\n`
  }

  function seed(): void {
    const dir = logDir()
    writeFileSync(
      join(dir, 'daemon.log'),
      extraLine('conexión perdida', { err: { message: 'ECONNRESET: socket hang up' } }) +
        extraLine('rate limit', { err: { message: 'rate limited' } }) +
        extraLine('sin err', { agentId: 'refiner' }),
    )
  }

  test('matchea substring simple contra un valor serializado', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&extra=err:ECONNRESET')).map((e) => e.msg)).toEqual([
      'conexión perdida',
    ])
  })

  // Sin ":" en absoluto — el bug real que motivó esto: un usuario escribe
  // "extra:ECONNRESET" (sin saber, o sin querer especificar, que el motivo
  // vive en extras.err) y espera que busque en cualquier campo.
  test('sin clave (sólo el patrón) busca en CUALQUIER campo de extras', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&extra=ECONNRESET')).map((e) => e.msg)).toEqual([
      'conexión perdida',
    ])
  })

  test('sin clave con * también funciona', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&extra=refin*')).map((e) => e.msg)).toEqual(['sin err'])
  })

  test('* matchea cualquier secuencia', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&extra=err:ECONN*')).map((e) => e.msg)).toEqual([
      'conexión perdida',
    ])
  })

  // No compila a RegExp — todo carácter que no sea `*`/`?` es literal, sin
  // escape (un `.`, un `(`, no hacen nada especial).
  test('los metacaracteres de regex se toman literales, salvo * y ?', async () => {
    seed()
    expect(await fetchEntries('?sort=asc&extra=err:ECONNRESETxsocket')).toHaveLength(0)
    seed()
    expect(await fetchEntries('?sort=asc&extra=err:ECONNRESET.socket')).toHaveLength(0)
  })

  // El valor real es "ECONNRESET: socket hang up" — dos caracteres (`:` y el
  // espacio) entre "ECONNRESET" y "socket", así que hacen falta dos `?`.
  test('? matchea exactamente un carácter', async () => {
    seed()
    expect(
      (await fetchEntries('?sort=asc&extra=err:ECONNRESET??socket')).map((e) => e.msg),
    ).toEqual(['conexión perdida'])
    expect(await fetchEntries('?sort=asc&extra=err:ECONNRESET?socket')).toHaveLength(0)
  })

  test('una línea sin la clave queda afuera', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&extra=err:*')).map((e) => e.msg)).toEqual([
      'conexión perdida',
      'rate limit',
    ])
  })

  // `?extra=` (valor vacío) no filtra nada — mismo criterio que el resto de
  // los filtros multi-select (`toSet`): un query mal armado no puede vaciar
  // el listado. Un patrón vacío CON clave (`err:`) sí es un 400, porque ahí
  // hay intención explícita de acotar a un campo y no decir con qué.
  test('un patrón vacío con clave corta con 400', async () => {
    seed()
    const res = await createServerLogsRouter().request('/?extra=err:')
    expect(res.status).toBe(400)
  })

  // Un chip vacío mezclado con uno válido (fácil de mandar sin querer desde
  // la UI, ej. `?extra=err:ECON&extra=`) no puede tirar 400 por algo que ni
  // siquiera es un patrón — se descarta, el resto de la query sigue viva.
  test('un elemento vacío mezclado con uno válido no tira 400 — se ignora', async () => {
    seed()
    const res = await createServerLogsRouter().request('/?sort=asc&extra=err:ECONNRESET&extra=')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ msg: string }> }
    expect(body.entries.map((e) => e.msg)).toEqual(['conexión perdida'])
  })

  test('una clave vacía explícita (":algo") corta con 400', async () => {
    seed()
    const res = await createServerLogsRouter().request(`/?extra=${encodeURIComponent(':algo')}`)
    expect(res.status).toBe(400)
  })

  test('un patrón demasiado largo corta con 400', async () => {
    seed()
    const res = await createServerLogsRouter().request(`/?extra=err:${'a'.repeat(201)}`)
    expect(res.status).toBe(400)
  })

  // El caso que rompía la implementación anterior basada en RegExp: muchos
  // `*` en serie son polinómicos de grado k en un motor de backtracking
  // (k=~90 acá, dentro del tope de 200 chars), y contra un valor que no
  // matchea eso cuelga el proceso. El algoritmo iterativo no tiene ese
  // costo — este test falla por timeout si alguna vez se vuelve a compilar
  // el patrón a regex.
  test('muchos * en serie no cuelgan el request', async () => {
    const dir = logDir()
    const stars = '*a'.repeat(90)
    // 2000 = MAX_EXTRA_VALUE_LEN del server — el tope real que ve el matcher.
    writeFileSync(join(dir, 'daemon.log'), extraLine('sin match', { err: 'b'.repeat(2000) }))
    const start = performance.now()
    const res = await createServerLogsRouter().request(
      `/?extra=${encodeURIComponent(`err:${stars}`)}`,
    )
    expect(performance.now() - start).toBeLessThan(1000)
    expect(res.status).toBe(200)
  })
})

// `search` (msg) usa el mismo glob case-insensitive que `extra` desde que se
// dejó de comparar con String.includes — ver globSearch en server-logs.ts.
describe('GET /api/server-logs — search (msg)', () => {
  function seed(): void {
    const dir = logDir()
    writeFileSync(
      join(dir, 'daemon.log'),
      line('2026-08-27T10:00:00.000Z', 'Conexión perdida: ECONNRESET') +
        line('2026-08-27T10:00:01.000Z', 'rate limited'),
    )
  }

  test('contains liso sigue funcionando', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&search=perdida')).map((e) => e.msg)).toEqual([
      'Conexión perdida: ECONNRESET',
    ])
  })

  test('es case-insensitive', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&search=econnreset')).map((e) => e.msg)).toEqual([
      'Conexión perdida: ECONNRESET',
    ])
  })

  test('acepta comodines glob (*/?), no una regexp arbitraria', async () => {
    seed()
    expect((await fetchEntries('?sort=asc&search=conex*reset')).map((e) => e.msg)).toEqual([
      'Conexión perdida: ECONNRESET',
    ])
  })

  // El msg NO se recorta antes de buscar (a diferencia de los valores de
  // `extras`) — un stack trace o un payload logueado ahí supera fácil los
  // 2000 chars, y el término buscado puede estar al final.
  test('matchea un término que está después de los primeros 2000 chars del mensaje', async () => {
    const dir = logDir()
    const long = 'a'.repeat(2500)
    writeFileSync(join(dir, 'daemon.log'), line('2026-08-27T10:00:00.000Z', `${long}NEEDLE`))
    expect((await fetchEntries('?sort=asc&search=needle')).map((e) => e.msg)).toEqual([
      `${long}NEEDLE`,
    ])
  })
})
