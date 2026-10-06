# @ia-flow/provider-remote

`Provider` que corre en otra máquina — `RemoteHub` + `RemoteProvider` + `RemoteRun` (el runner) y
`HostClient` + `RunnerLink` (el host). El contrato y el porqué de cada decisión están en
`README.md`: leelo antes de tocar algo.

## Estructura

```
src/
├── protocol.ts        el cable, en zod: lo único que comparten los dos lados
├── RemoteHub.ts       runner: suscripción, long-poll de tareas, rutas de las corridas, vencimiento
├── RemoteProvider.ts  runner: `remote:<name>` — canAccept (tope + condiciones) y run (arma la tarea
│                      con el ProviderRunContext, entrega y espera el resultado)
├── RemoteRun.ts       runner: una corrida entregada — las tools del engine, la bandeja, la
│                      conversación, el texto y el resultado
├── HostClient.ts      host: se suscribe, pide tareas, corre cada una (`TaskRunner`) y devuelve el
│                      resultado
├── RunnerLink.ts      host: lo que el provider del host necesita del runner, sobre las rutas de la
│                      corrida
└── tests/             end-to-end sin red: el fetch del host le pega al `fetch` del hub
```

## Reglas

- **Un cambio de cable va en `protocol.ts`** y se valida en los dos lados.
- **El host abre todas las conexiones**: nada que el runner tenga que alcanzar.
- **El runner no sabe con qué provider corre el host**: nada de este paquete puede depender del
  CLI ni de la API. Lo propio de un provider vive en su paquete y corre en el host.
- **Nada de red real en los tests**: `wire(hub)` (`tests/fixtures.ts`).
