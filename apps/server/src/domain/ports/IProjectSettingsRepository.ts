// Raw key/value store backed by the `project_settings` table. Also owns
// well-known composite keys (scan_roots) that other domains read/write.
export interface IProjectSettingsRepository {
  getAll(): Record<string, string>
  get(key: string): string | null
  set(key: string, value: string): void
  setMany(settings: Record<string, string>): void
  delete(key: string): void

  // scan_roots — JSON-encoded string[] under the 'scan_roots' key.
  getScanRoots(): string[]
  setScanRoots(roots: string[]): void
}
