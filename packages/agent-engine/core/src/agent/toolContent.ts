/**
 * El resultado de una tool que lleva imágenes, además de texto. La interfaz `Tool` devuelve un
 * string (lo leen la traza, los logs, los providers de CLI y el host remoto), así que el contenido
 * viaja serializado detrás de una marca que ningún resultado de texto trae. Un provider que muestra
 * imágenes al modelo (`anthropic-api`) lo arma en bloques con `parseToolContent`; el resto lee
 * `toolContentText`: el texto y una línea por imagen.
 */

export type ToolImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export const TOOL_IMAGE_MEDIA_TYPES: readonly ToolImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

export type ToolContentBlock =
  | { type: 'text'; text: string }
  /** `data` en base64, sin el prefijo `data:`. */
  | { type: 'image'; mediaType: ToolImageMediaType; data: string }

const MARK = '\u0000ia-flow:tool-content\u0000'

/** El string que devuelve una tool con imágenes. */
export function toolContent(blocks: ToolContentBlock[]): string {
  return `${MARK}${JSON.stringify(blocks)}`
}

/** Los bloques de un resultado con imágenes; `undefined` si es texto común. */
export function parseToolContent(result: string): ToolContentBlock[] | undefined {
  if (!result.startsWith(MARK)) return undefined
  try {
    const blocks = JSON.parse(result.slice(MARK.length)) as unknown
    return Array.isArray(blocks) ? blocks.filter(isBlock) : undefined
  } catch {
    return undefined
  }
}

/** El resultado como texto, para quien no muestra imágenes (y para la traza: sin el base64). */
export function toolContentText(result: string): string {
  const blocks = parseToolContent(result)
  if (!blocks) return result
  return blocks
    .map((block) =>
      block.type === 'text'
        ? block.text
        : `[imagen ${block.mediaType}, ${Math.round((block.data.length * 3) / 4 / 1024)} KB]`,
    )
    .join('\n')
}

function isBlock(value: unknown): value is ToolContentBlock {
  if (typeof value !== 'object' || value === null) return false
  const block = value as Record<string, unknown>
  if (block.type === 'text') return typeof block.text === 'string'
  return (
    block.type === 'image' &&
    typeof block.data === 'string' &&
    TOOL_IMAGE_MEDIA_TYPES.includes(block.mediaType as ToolImageMediaType)
  )
}
