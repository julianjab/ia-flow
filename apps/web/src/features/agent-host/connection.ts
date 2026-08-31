// A qué agent-host le habla esta pantalla.
//
// ── Por qué esto ya no es un registro propio ──────────────────────────────
//
// Antes acá vivía una LISTA de agent-hosts con su token, en su propio
// localStorage y con su propia barra de conexión, en paralelo a la lista de
// servers de `features/servers/`. Eran dos registros de la misma cosa —una URL
// y un token de un proceso de ia-flow— y esa duplicación se pagaba dos veces:
// el operador tenía que dar de alta la misma máquina en dos pantallas, y cada
// una podía tener un token distinto para la misma URL sin que nada lo dijera.
//
// Ahora hay un solo registro. El picker sondea lo declarado, descubre de qué
// tipo es cada URL (`ServerKind`) y "entrar" a un agent-host es lo mismo que
// entrar a un server: se aplica la elección y el shell dibuja la navegación
// que corresponde. Este módulo es lo que queda: traducir esa elección a un
// cliente HTTP.

import { currentBaseUrl, getSelectedKind, getSelectedToken } from '@/features/servers/selection'
import type { AxiosInstance } from 'axios'
import { agentHostClient } from './api'

/**
 * ¿Lo que estamos mirando es un agent-host?
 *
 * Lo usan las pantallas de esta feature para no pegarle a `/v1/*` cuando el
 * elegido es un server: sin el chequeo, un deep-link a `/agent-host` estando
 * en un server disparaba seis requests que devolvían 404 y dejaban la pantalla
 * en "no respondió" — un fallo que parece del agent-host y no lo es.
 */
export function isAgentHostSelected(): boolean {
  return getSelectedKind() === 'agent-host'
}

/** La URL del agent-host elegido, absoluta. */
export function selectedAgentHostUrl(): string {
  return currentBaseUrl()
}

/**
 * Un cliente contra el agent-host elegido.
 *
 * Se construye por llamada y no una vez por módulo a propósito: los módulos se
 * evalúan al importarse, o sea antes de que `restoreSelectedServer()` haya
 * corrido, y un cliente congelado ahí habría quedado apuntando a la URL vacía.
 */
export function selectedAgentHostClient(): AxiosInstance {
  return agentHostClient(selectedAgentHostUrl(), getSelectedToken() ?? '')
}
