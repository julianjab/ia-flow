# packages/rules — el motor de eventos, reglas y acciones

Sin I/O, sin estado, sin dependencias más allá de `@ia-flow/shared`. Todo lo concreto
(la DB, el HTTP, los agentes) entra por inyección desde `apps/server`.

## Cómo agregar un productor de eventos

Los productores vienen en **dos formas**, y la diferencia es quién tiene la iniciativa.

### 1. De ingreso — algo llega y hay que traducirlo

Un webhook de GitHub, uno de Slack, un `POST` a la API. El ciclo de vida es el del
servidor HTTP; lo único propio es la **traducción**.

Escribís un `EventNormalizer`: una función pura, sin I/O, que recibe el payload crudo y
devuelve `EngineEvent | null`.

```ts
// apps/server/src/adapters/<sistema>/webhook-events.ts
export function linearWebhookEvent(payload: unknown, deliveryId?: string): EngineEvent | null {
  const p = payload as LinearPayload
  if (p.action !== 'create') return null          // ← null, no un evento vacío

  return createEvent({
    id: deliveryId ? `${deliveryId}:linear.issue_created` : undefined,
    type: 'linear.issue_created',
    source: 'linear',
    scope: {},                                     // ← no inventes scope
    payload: { title: p.data.title },
  })
}
```

Y la ruta lo invoca:

```ts
// apps/server/src/routes/webhooks.ts
const event = linearWebhookEvent(payload, c.req.header('linear-delivery'))
if (!event) return c.json({ ok: true, ignored: true })
return c.json({ ok: true, outcome: await eventBus.publish(event) })
```

Ejemplos vivos: `adapters/github/webhook-events.ts`, `adapters/slack/webhook-events.ts`.

### 2. De iniciativa — nadie llama, hay que ir a mirar

Un tick de cron, un barrido de vencimientos, un watcher del filesystem. Tiene ciclo de
vida propio, así que implementás `EventProducer`.

Para el caso más común —mirar cada N milisegundos— usá `createIntervalProducer` en vez
de escribir tu propio `setInterval`:

```ts
const staleTasksProducer = createIntervalProducer({
  id: 'stale-tasks',
  intervalMs: 60_000,
  onError: (err) => log.error({ err }, 'Fallo el barrido de tasks estancadas'),
  produce: async (at) => {
    const stale = await taskRepo.olderThan(at)
    return stale.map((t) =>
      createEvent({ type: 'task.stale', source: 'engine', scope: { projectId: t.projectId }, payload: { t } }),
    )
  },
})
```

Y lo agregás a `PRODUCERS` en `apps/server/src/daemon.ts`. **No hay más cableado que
eso.**

## Las cuatro reglas que se olvidan

1. **Poné un `id` estable cuando la fuente tenga uno.** El `X-GitHub-Delivery`, el
   `event_id` de Slack, el minuto exacto de un tick. El bus deduplica por ahí, y sin eso
   un reintento de la fuente dispara las reglas dos veces.
   Si el hecho **no** tiene identidad natural —dos scans del mismo issue son dos hechos
   distintos— dejá que `createEvent` sintetice uno.

2. **No inventes scope.** Si no sabés de qué proyecto es, mandá `{}`. El matcher es
   *fail-closed*: sólo lo verán las reglas globales, que es lo correcto. Un scope
   adivinado dispara reglas de un proyecto ajeno.
   Resolver el scope, cuando se puede, va **en el borde** (la ruta, con acceso a la DB),
   nunca dentro del normalizador — así el normalizador se testea sin levantar nada.

3. **Devolvé `null` en vez de un evento vacío.** Un delivery que no interesa no es un
   evento, y publicar uno "por las dudas" obliga a cada regla a filtrarlo.

4. **Un fallo del productor no puede voltear nada.** Loguealo y seguí: el próximo tick o
   el próximo delivery vuelve a intentar. `createIntervalProducer` ya trae el `catch` —
   sin él, un tick que tira mata el intervalo y el productor deja de producir para
   siempre sin que nada lo diga.

## Un evento derivado NO se crea con `createEvent`

Si el evento nace **dentro** del engine como consecuencia de otro (la acción `emit`, un
`wait.resumed`), usá `deriveEvent(cause, ...)`. Hereda `causationId` y `depth + 1`, que
es lo único que impide que dos reglas que se emiten entre sí hagan un loop infinito —
`createEvent` reiniciaría la profundidad en 0 y el tope del bus dejaría de frenar nada.

## Mapa del paquete

| Archivo | Qué es |
| --- | --- |
| `scope.ts` | `matchScope` — la ubicación declarada de algo ES su filtro |
| `when.ts` | el DSL de condiciones, con caminos anidados y 10 operadores |
| `bus.ts` | `InMemoryEventBus` — entrega, dedupe y tope de profundidad |
| `producer.ts` | el contrato de productor (este documento) |
| `match.ts` | `matchRules` — qué reglas aplican a un evento |
| `runner.ts` | ejecuta el `do[]` de una regla, en orden |
| `actions.ts` | el registry de acciones |
| `waits.ts` / `wait-handler.ts` | esperas y pausas |
| `status-diff.ts` | el scan como hecho, no como observación |
| `schedule.ts` | el parser de cron |
