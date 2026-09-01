import { actionRepo, toolRepo } from './container.js'
import { applyEditableTools } from './editable-tools.js'

/**
 * Vuelve a proyectar la config de tools sobre el registry del proceso.
 *
 * Vive acá y no dentro de una ruta porque tiene DOS disparadores que no se
 * conocen entre sí: el CRUD de tools (cambió la tool) y el CRUD de acciones
 * (cambió lo que la tool ejecuta). `toolFromAction` captura el objeto `action`
 * en su closure, así que sin esta segunda llamada una acción editada seguía
 * corriendo con su body VIEJO —y una borrada con `force` quedaba invocable
 * contra una fila que ya no existe— hasta reiniciar el proceso.
 *
 * `applyEditableTools` es convergente e idempotente: registra lo que aplica y
 * da de baja lo que ya no, así que llamarla de más no cuesta nada.
 */
export async function reapplyEditableTools(): Promise<void> {
  await applyEditableTools({
    listTools: () => toolRepo.list(),
    getAction: (id) => actionRepo.getById(id),
  })
}
