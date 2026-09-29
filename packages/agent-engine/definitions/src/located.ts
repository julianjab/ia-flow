/**
 * Corre `build` y, si tira, antepone `where` (`<archivo>: <ruta>`) al mensaje — salvo que el error
 * ya diga de qué archivo es (lo tiró un nivel más adentro, con una ruta más precisa).
 */
export function located<T>(where: string, build: () => T): T {
  try {
    return build()
  } catch (error) {
    const message = (error as Error).message
    const file = where.split(': ')[0] as string
    throw new Error(message.startsWith(file) ? message : `${where}: ${message}`)
  }
}
