# @ia-flow/provider-remote

`Provider` que corre en otra máquina — `RemoteHub` + `RemoteProvider` (el runner) y `HostClient`
(el host). El contrato y el porqué de cada decisión están en `README.md`: leelo antes de tocar algo.

## Estructura

```
src/
├── protocol.ts        el cable, en zod: lo único que comparten los dos lados
├── RemoteHub.ts       runner: suscripción, long-poll de tareas, canales de las corridas, vencimiento
├── RemoteProvider.ts  runner: `remote:<name>` — canAccept (tope + condiciones) y run (entrega y espera)
├── HostClient.ts      host: se suscribe, pide tareas, corre cada una (`TaskRunner`) y reporta
└── tests/             end-to-end sin red: el fetch del host le pega al `fetch` del hub
```

## Reglas

- **Un cambio de cable va en `protocol.ts`** y se valida en los dos lados.
- **El host abre todas las conexiones**: nada que el runner tenga que alcanzar.
- **El canal es el de `@ia-flow/provider-shared`**: lo que cambie en cómo se sirven tools o hooks,
  va ahí, no acá.
- **Nada de red real en los tests**: `wire(hub)` (`tests/fixtures.ts`).
