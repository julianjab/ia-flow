// El dashboard que alguien editó para UN runner: pisa al que trae la web. Vive en el navegador (o en
// la ventana de la app de escritorio): es una preferencia de quien mira, no del runner. Cada acceso
// va en try/catch — en un modo privado o con el storage bloqueado la web sigue con el suyo.

const KEY = 'ia-flow:dashboards:override:'

export function loadOverride(serverKey: string): string | null {
  try {
    return localStorage.getItem(KEY + serverKey)
  } catch {
    return null
  }
}

export function saveOverride(serverKey: string, text: string): boolean {
  try {
    localStorage.setItem(KEY + serverKey, text)
    return true
  } catch {
    return false
  }
}

export function clearOverride(serverKey: string): void {
  try {
    localStorage.removeItem(KEY + serverKey)
  } catch {
    /* sin storage no hay nada que borrar */
  }
}
