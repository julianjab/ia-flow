/** Nodos planos de UN nivel de un objeto — no recursa. `JsonTreeNode.vue` se
 *  llama a sí mismo con `value` cuando `hasChildren(value)` es true, así que
 *  la recursión vive en el componente (que puede pintar la sangría real de
 *  Vue) y este módulo se queda con las funciones puras, testeables sin
 *  montar nada. */
export interface JsonTreeField {
  key: string
  value: unknown
  /** Path completo desde la raíz de la línea (`extras.scope.issueId`) — es
   *  lo mismo que espera `toggleColumn`/`isColumnActive`: con la raíz siendo
   *  `entry`, un campo base como `time` queda con path `time` (sin
   *  prefijo) y cualquier cosa dentro de `extras` arrastra el prefijo
   *  `extras.` — ya no hace falta un guard de colisión "esto se llama
   *  igual que una columna base" (ver `ServerLogsSection.vue`): los paths
   *  son inequívocos por construcción. */
  path: string
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `true` cuando el valor se expande como sub-árbol en vez de mostrarse como
 *  hoja — un objeto vacío (`{}`) se trata como hoja, no como un nodo sin
 *  hijos que renderizaría un contenedor vacío. */
export function hasChildren(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length > 0
}

export function jsonTreeFields(data: unknown, parentPath: string): JsonTreeField[] {
  if (!isPlainObject(data)) return []
  return Object.entries(data).map(([key, value]) => ({
    key,
    value,
    path: parentPath ? `${parentPath}.${key}` : key,
  }))
}

/** Sintaxis JSON de verdad (strings entre comillas) para el valor de una
 *  hoja del árbol — es lo que reemplaza al `<pre>{{ JSON.stringify(...) }}`
 *  de antes: una sola vista, no dos que dicen lo mismo distinto.
 *
 * Sin corte de longitud: este árbol ES "el JSON completo" (así lo etiquela
 * el header de ExecutionsSection) — un prompt largo o una descripción
 * cortada con "…" no tiene forma de leerse completo desde acá. El wrap de
 * `.detail-field-value` (JsonTreeNode.vue) es lo que hace que un valor largo
 * no reviente el layout en vez de esconderlo. */
export function formatJsonLeaf(value: unknown): string {
  if (value === undefined) return '—'
  return JSON.stringify(value) ?? String(value)
}
