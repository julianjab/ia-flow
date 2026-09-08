/**
 * Las secciones de configuración del server (`/general/*`), en una sola lista.
 *
 * La tenían dos pantallas: el sidebar del shell (grupo `global`) y el índice
 * de `Más`. Mientras estuvieron por separado, `Más` prometía "Configuración
 * general · 11" y llevaba a UNA —agentes—, así que bajo `--bp-shell`, donde no
 * hay sidebar, las otras ocho no tenían camino: sólo la URL a mano.
 *
 * Vive en `router/` porque es lo que son —rutas de la app con su nombre— y
 * porque ni el shell ni `Más` son dueños de la lista: los dos la muestran.
 */
/**
 * Los ids son una UNIÓN, no `string`: el shell los usa como clave de su
 * `SECTION_PATH`, y con `string` agregar una entrada acá compilaba igual para
 * después navegar a `undefined`. Que el compilador lo agarre es la mitad de
 * por qué la lista está compartida.
 */
export type GeneralSectionId =
  | 'agentes'
  | 'pipeline'
  | 'acciones'
  | 'tools'
  | 'system-prompts'
  | 'providers'
  | 'mcp-catalog'
  | 'entorno'
  | 'escaneo'

export interface AppSection {
  id: GeneralSectionId
  label: string
  path: string
}

export const GENERAL_SECTIONS: AppSection[] = [
  { id: 'agentes', label: 'agentes', path: '/general/agentes' },
  { id: 'pipeline', label: 'pipeline', path: '/general/pipeline' },
  { id: 'acciones', label: 'acciones', path: '/general/acciones' },
  { id: 'tools', label: 'tools', path: '/general/tools' },
  { id: 'system-prompts', label: 'system prompts', path: '/general/system-prompts' },
  { id: 'providers', label: 'providers', path: '/general/providers' },
  { id: 'mcp-catalog', label: 'mcp catalog', path: '/general/mcp-catalog' },
  { id: 'entorno', label: 'entorno', path: '/general/entorno' },
  { id: 'escaneo', label: 'escaneo', path: '/general/escaneo' },
]
