/** El id con el que un host aparece en el registry de providers: `remote:<name>`. */
export function providerId(name: string): string {
  return `remote:${name}`
}
