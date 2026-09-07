import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Los destinos de la tab bar tienen que ser tabs VÁLIDOS del proyecto.
 *
 * `ProjectDetailView` cae a `overview` ante un tab desconocido, así que un
 * destino mal escrito no rompe nada: abre otra pantalla en silencio, con la
 * URL correcta en la barra de direcciones. Es el modo de fallo más difícil de
 * ver, y el que tuvo `que-sigue` hasta que se agregó la ruta.
 */
describe('destinos de la navegación mobile', () => {
  const view = readFileSync('src/views/ProjectDetailView.vue', 'utf8')
  const tabbar = readFileSync('src/components/MobileTabBar.vue', 'utf8')

  it('cada tab de proyecto de la barra existe en VALID_TABS', () => {
    const valid = view.slice(view.indexOf('VALID_TABS'), view.indexOf('activeTab'))
    for (const tab of ['que-sigue', 'tareas', 'executions']) {
      expect(tabbar).toContain(`tabPath('${tab}')`)
      expect(valid).toContain(`'${tab}'`)
    }
  })
})
