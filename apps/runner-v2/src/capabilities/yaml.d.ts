/** Bun importa un `.yaml` como su documento ya parseado (y lo embebe en el bundle). */
declare module '*.yaml' {
  const doc: Record<string, unknown>
  export default doc
}
