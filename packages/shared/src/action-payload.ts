// Qué campos del payload LEE una acción.
//
// Es la mitad que faltaba para que una tool definida y la acción que ejecuta no
// puedan contradecirse. El camino completo es uno solo:
//
//   el modelo invoca la tool  →  su input viaja como `event.payload`
//   (`composition/editable-tools.ts`)  →  la acción lo interpola con
//   `{{event.payload.<campo>}}`  (adapters `http-action.ts` / `script-action.ts`)
//
// O sea que el "schema de una tool" no es una decisión libre: los campos útiles
// son EXACTAMENTE los placeholders que su acción escribe. Un parámetro que la
// acción no lee es un dato que el modelo entrega a la nada; un placeholder sin
// parámetro se interpola como string vacío —los dos adapters lo resuelven así a
// propósito— y falla en silencio del otro lado.
//
// Por eso esto vive acá y no en el formulario: es una propiedad del contrato de
// la acción, y la UI sólo la muestra. Es el caso exacto que justifica
// `packages/shared` —los dos lados tienen que coincidir— y no una utilidad
// suelta: el server INTERPOLA esta sintaxis y la web tiene que decir qué campos
// lee. Si divergen, la UI miente sobre lo que la acción va a recibir.
//
// **Se lee la misma sintaxis que interpolan los adapters**, incluidos los
// espacios opcionales (`{{ event.payload.x }}`). Y sólo los VALORES, nunca las
// claves: `http-action` interpola `headers[k]` y no `k`, y `script-action` hace
// lo mismo con `env`.

/** Los placeholders de payload en un string suelto. Global: se usa con
 *  `matchAll`, que clona el regex y no arrastra `lastIndex`. */
const PAYLOAD_PLACEHOLDER = /\{\{\s*event\.payload\.([\w.]+?)\s*\}\}/g

function walk(value: unknown, visit: (path: string) => void): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PAYLOAD_PLACEHOLDER)) visit(m[1])
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) walk(v, visit)
  }
}

/**
 * Los caminos completos que la acción lee: `['branch', 'pr.number']`.
 *
 * En orden de aparición y sin repetidos — es lo que se le muestra a alguien que
 * está armando la tool, así que el orden del texto es el orden útil.
 */
export function extractPayloadPaths(body: unknown): string[] {
  const seen = new Set<string>()
  walk(body, (p) => seen.add(p))
  return [...seen]
}

/**
 * Los campos de PRIMER nivel: `['branch', 'pr']`.
 *
 * Es la lista que le corresponde a un `input_schema`, cuyas `properties` son
 * por definición las claves de arriba de todo del objeto que manda el modelo.
 * `{{event.payload.pr.number}}` no pide un parámetro `pr.number`: pide un `pr`
 * con un `number` adentro.
 */
export function extractPayloadFields(body: unknown): string[] {
  const seen = new Set<string>()
  walk(body, (p) => seen.add(p.split('.')[0]))
  return [...seen]
}

/**
 * ¿Esta acción interpola el payload, o lo ignora?
 *
 * `http` y `script` lo leen; `emit` publica su payload declarado TAL CUAL (ver
 * `emit-action.ts`, que no interpola nada) y `agent` no lee más que un
 * `payload.item` que una tool no produce. Decirlo es lo que evita el peor caso
 * de esta feature: una tool con parámetros prolijos sobre una acción que jamás
 * los va a mirar.
 */
export function actionReadsPayload(action: string): boolean {
  return action === 'http' || action === 'script'
}
