// Gate en memoria que el daemon consulta antes de escanear un proyecto.
// El núcleo sólo necesita prender/apagar y leer — quién guarda el estado
// (hoy un Set de módulo en @ia-flow/issue-sources) es problema del adapter.
export interface IPollingGate {
  pause(projectId: string): void
  resume(projectId: string): void
  isPaused(projectId: string): boolean
  listPaused(): string[]
}
