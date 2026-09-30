# @ia-flow/provider-remote

`Provider` que corre en otra máquina — cliente (`RemoteProvider`) y host (`RemoteProviderHost`).
El contrato de uso y el porqué de cada decisión están en `README.md`: leelo antes de tocar algo.

## Estructura

```
src/
├── protocol.ts            el cable, en zod: lo único que comparten los dos lados
├── config.ts              la entrada `type: remote` de runner.yaml
├── RemoteProvider.ts      cliente: canAccept (sonda) + run (abre y delega en RemoteRun)
├── RemoteRun.ts           cliente, una corrida: el loop de sync, las tools corriendo acá
├── RemoteProviderHost.ts  host: el handler de fetch, auth, topes, barrido de huérfanas
├── HostedRun.ts           host, una corrida: el provider local con tools proxy + la cola de eventos
├── AdmissionRules.ts      reglas del host sobre las pistas (puro)
├── traceContext.ts        el `traceparent` del agente: se arma en el runner y se lee en el host
└── tests/                 end-to-end sin red: el fetch del cliente le pega al handler del host
```

## Reglas

- **Un cambio de cable va en `protocol.ts`** y se valida en los dos lados. Un campo nuevo es
  opcional o tiene default: un runner y un host de versiones distintas tienen que seguir
  hablando.
- **Todo lo que el runner manda es idempotente**: se reenvía hasta que un sync vuelve bien. Un
  campo nuevo de `SyncRequest` necesita su forma de descartar el repetido en `HostedRun`.
- **Nada de red real en los tests**: `fetchImpl` al handler del host (`tests/fixtures.ts`).
- **Los timings son inyectables** (`timing`, `orphanAfterMs`, `sweep(now)`): nada de esperar
  segundos reales en un test.
