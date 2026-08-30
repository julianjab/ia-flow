import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const OPCIONES: ComboOption[] = [
  { value: 'pr.opened', hint: 'se abrió un PR', glyph: '◆' },
  { value: 'pr.merged', hint: 'se mergeó' },
  { value: 'ci.finished', hint: 'terminó el CI' },
]

const mk = (props: Record<string, unknown> = {}) =>
  mount(ComboBox, {
    props: { modelValue: props.multiple ? [] : '', options: OPCIONES, ...props },
    attachTo: document.body,
  })

const abrir = async (w: ReturnType<typeof mk>) => {
  await w.find('input').trigger('focus')
  return w
}
const opciones = (w: ReturnType<typeof mk>) => w.findAll('.cb-opt__label').map((e) => e.text())
const ultimo = (w: ReturnType<typeof mk>) => w.emitted('update:modelValue')?.at(-1)?.[0]

describe('ComboBox — común a las tres formas', () => {
  it('abre al enfocar y lista las opciones con su hint', async () => {
    const w = await abrir(mk())
    expect(opciones(w)).toEqual(['pr.opened', 'pr.merged', 'ci.finished'])
    expect(w.text()).toContain('se abrió un PR')
  })

  it('filtra por value y por hint', async () => {
    const w = await abrir(mk())
    await w.find('input').setValue('merge')
    expect(opciones(w)).toEqual(['pr.merged'])

    await w.find('input').setValue('terminó')
    expect(opciones(w)).toEqual(['ci.finished'])
  })

  it('navega con flechas y elige con Enter', async () => {
    const w = await abrir(mk())
    await w.find('input').trigger('keydown', { key: 'ArrowDown' })
    await w.find('input').trigger('keydown', { key: 'ArrowDown' })
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(ultimo(w)).toBe('pr.merged')
  })

  it('sin coincidencias lo dice', async () => {
    const w = await abrir(mk({ emptyText: 'Nada acá' }))
    await w.find('input').setValue('zzz')
    expect(w.text()).toContain('Nada acá')
  })

  it('muestra el error de carga en vez de una lista vacía', async () => {
    const w = await abrir(mk({ error: 'no se pudo cargar' }))
    expect(w.find('.cb-note--error').text()).toContain('no se pudo cargar')
  })
})

describe('ComboBox — un solo valor', () => {
  it('elegir reemplaza y cierra', async () => {
    const w = await abrir(mk({ modelValue: 'pr.opened' }))
    await w.findAll('.cb-opt')[1].trigger('click')
    expect(ultimo(w)).toBe('pr.merged')
    expect(w.find('.cb-list').exists()).toBe(false)
  })

  // A diferencia del modo `multiple`, acá la opción elegida SIGUE en la lista:
  // con un solo valor, verlo entre los demás es cómo se sabe cuál está puesto.
  // Sacarlo dejaría la lista sin el que importa.
  it('la opción elegida sigue listada', async () => {
    const w = await abrir(mk({ modelValue: 'pr.opened' }))
    expect(opciones(w)).toContain('pr.opened')
  })

  // Los chips son el lenguaje del multi: dicen "hay varios y éste es uno de
  // ellos". Con un solo valor no hay nada que enumerar, y una ficha encerrando
  // todo el contenido del campo se lee como una lista de uno.
  it('el valor elegido es el texto del campo, no un chip', () => {
    const w = mk({ modelValue: 'pr.opened' })
    expect(w.findAll('.cb-chip')).toHaveLength(0)
    expect((w.get('input').element as HTMLInputElement).value).toBe('pr.opened')
  })

  it('la ✕ lo vacía', async () => {
    const w = mk({ modelValue: 'pr.opened' })
    await w.find('.cb-clear').trigger('click')
    expect(ultimo(w)).toBe('')
  })

  // Abrir un campo ya elegido tiene que mostrar TODAS las opciones: filtrar por
  // el valor que ya está puesto dejaría una lista de un solo elemento — el que
  // ya está.
  it('abrir no filtra por el valor que ya tiene', async () => {
    const w = await abrir(mk({ modelValue: 'pr.opened' }))
    expect(opciones(w)).toHaveLength(3)
  })

  it('pero escribir encima sí filtra', async () => {
    const w = await abrir(mk({ modelValue: 'pr.opened' }))
    await w.find('input').setValue('ci')
    expect(opciones(w)).toEqual(['ci.finished'])
  })
})

describe('ComboBox — varios valores', () => {
  it('acumula chips y no ofrece lo ya elegido', async () => {
    const w = await abrir(mk({ multiple: true, modelValue: ['pr.opened'] }))
    expect(opciones(w)).not.toContain('pr.opened')

    await w.findAll('.cb-opt')[0].trigger('click')
    expect(ultimo(w)).toEqual(['pr.opened', 'pr.merged'])
  })

  it('sigue abierto después de elegir, para poder sumar otro', async () => {
    const w = await abrir(mk({ multiple: true }))
    await w.findAll('.cb-opt')[0].trigger('click')
    expect(w.find('.cb-list').exists()).toBe(true)
  })

  // El gesto esperado en un campo de tags, y evita apuntarle a una ✕ de 12px.
  it('Backspace con el campo vacío borra el último chip', async () => {
    const w = mk({ multiple: true, modelValue: ['pr.opened', 'pr.merged'] })
    await w.find('input').trigger('keydown', { key: 'Backspace' })
    expect(ultimo(w)).toEqual(['pr.opened'])
  })

  it('pero no si se está escribiendo algo', async () => {
    const w = mk({ multiple: true, modelValue: ['pr.opened'] })
    await w.find('input').setValue('ci')
    await w.find('input').trigger('keydown', { key: 'Backspace' })
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})

describe('ComboBox — valores propios', () => {
  // Con `allowCustom: false` la lista es la AUTORIDAD: escribir algo que no
  // existe no puede guardar nada. Es el caso de un id que otro sistema resuelve
  // — un nombre de Slack a mano se ve bien y no taguea a nadie.
  it('sin allowCustom no ofrece lo escrito', async () => {
    const w = await abrir(mk())
    await w.find('input').setValue('mi.evento')
    expect(w.find('.cb-opt--custom').exists()).toBe(false)
    expect(w.text()).toContain('Sin resultados')
  })

  it('con allowCustom lo ofrece, marcado como propio', async () => {
    const w = await abrir(mk({ allowCustom: true }))
    await w.find('input').setValue('mi.evento')

    const custom = w.find('.cb-opt--custom')
    expect(custom.exists()).toBe(true)
    expect(custom.text()).toContain('mi.evento')
    expect(custom.text()).toContain('valor propio')
  })

  // Al final y no al principio: Enter sobre una lista filtrada elige lo
  // conocido, que es lo que casi siempre se quiere.
  it('el valor propio va último, así Enter prefiere lo conocido', async () => {
    const w = await abrir(mk({ allowCustom: true }))
    await w.find('input').setValue('pr.')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(ultimo(w)).toBe('pr.opened')
  })

  // El caso que hacía perder lo escrito: se tipea y se hace click en “Guardar”.
  // El blur del campo llega ANTES que el submit, así que si salir descartara el
  // texto, el form se guardaría con el valor viejo sin que nada lo avise.
  it('salir del campo guarda lo escrito', async () => {
    const w = await abrir(mk({ allowCustom: true }))
    await w.find('input').setValue('mi.evento')
    await w.find('input').trigger('blur')
    expect(ultimo(w)).toBe('mi.evento')
  })

  // El bug más fino de `onBlur`: un texto que coincide EXACTO con una opción
  // no es un valor propio, así que `customValue` daba `null` y el campo
  // revertía al valor viejo en silencio — fallando justo para los valores que
  // la lista conoce, que son los que uno espera que anden.
  it('salir con un texto que SÍ está en la lista también lo guarda', async () => {
    const w = await abrir(mk({ modelValue: 'pr.opened' }))
    await w.find('input').setValue('pr.merged')
    await w.find('input').trigger('blur')
    expect(ultimo(w)).toBe('pr.merged')
  })

  it('pero sin allowCustom salir lo descarta', async () => {
    const w = await abrir(mk())
    await w.find('input').setValue('mi.evento')
    await w.find('input').trigger('blur')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('no lo ofrece si coincide exacto con una opción', async () => {
    const w = await abrir(mk({ allowCustom: true }))
    await w.find('input').setValue('pr.merged')
    expect(w.find('.cb-opt--custom').exists()).toBe(false)
  })
})

describe('ComboBox — lista del server', () => {
  // El label de un valor puede llegar DESPUÉS: SlackChannelField guarda un id
  // y su nombre lo resuelve un fetch. Sin respetar lo que se está escribiendo,
  // ese fetch llegando a destiempo le borraba el texto al operador.
  it('opciones que llegan tarde no pisan lo que se está escribiendo', async () => {
    const w = mount(ComboBox, {
      props: { modelValue: 'C1', options: [], allowCustom: true },
      attachTo: document.body,
    })
    await w.find('input').trigger('focus')
    await w.find('input').setValue('gen')
    await w.setProps({ options: [{ value: 'C1', label: '#general' }] })
    expect((w.get('input').element as HTMLInputElement).value).toBe('gen')
  })

  it('avisa lo que se escribe para que el server busque', async () => {
    const w = await abrir(mk({ remote: true }))
    await w.find('input').setValue('juli')
    expect(w.emitted('search')?.at(-1)).toEqual(['juli'])
  })

  // Filtrar encima de un resultado del server esconde lo que el server ya dijo
  // que coincide: se busca por nombre real y vuelve el handle, que no contiene
  // lo tipeado. Con `remote` la lista se muestra tal cual vino.
  it('no vuelve a filtrar lo que ya vino filtrado', async () => {
    const w = await abrir(mk({ remote: true }))
    await w.find('input').setValue('zzz')
    expect(opciones(w)).toHaveLength(3)
  })
})

describe('ComboBox — deshabilitado', () => {
  it('no abre ni deja quitar', async () => {
    const w = mk({ modelValue: 'pr.opened', disabled: true })
    await w.find('input').trigger('focus')
    expect(w.find('.cb-list').exists()).toBe(false)
    expect(w.find('.cb-chip__x').exists()).toBe(false)
  })
})
