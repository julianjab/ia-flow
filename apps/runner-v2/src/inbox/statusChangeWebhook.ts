/**
 * El webhook `projects_v2_item` que GitHub manda cuando alguien mueve una card a otra columna, armado
 * a mano: despachado crudo, recorre el intake (`resolve_task` lee la card, el issue y el PR frescos)
 * y las pipelines igual que si la persona hubiera movido la card. Es cómo la bandeja vuelve a correr
 * el pipeline de una columna (re-ejecutar el review) sin tocar el board.
 */
export interface StatusChange {
  /** El id del item en el board (`PVTI_…`). */
  itemId: string
  /** La columna a la que "llega" la card. */
  status: string
  /** Quién lo pidió: su login queda como `sender` (y no es el eco del propio runner). */
  sender: string
}

export function statusChangeWebhook({ itemId, status, sender }: StatusChange) {
  return {
    event: 'projects_v2_item',
    id: `rerun-${itemId}-${Date.now()}`,
    payload: {
      action: 'edited',
      projects_v2_item: { node_id: itemId, content_type: 'Issue' },
      // Sin `from`: `resolve_task` sólo descarta un cambio cuyo from y to son iguales.
      changes: {
        field_value: { field_name: 'Status', field_type: 'single_select', to: { name: status } },
      },
      sender: { login: sender },
    },
  }
}
