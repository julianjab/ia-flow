export interface IEnvVarRepository {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  loadIntoProcess(): void
}
