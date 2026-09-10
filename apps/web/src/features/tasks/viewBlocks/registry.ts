import type { Component } from 'vue'
import RowActionBlock from '@/features/tasks/viewBlocks/RowActionBlock.vue'

/**
 * Primitiva → componente que la dibuja. La otra mitad de `uiContract.ts`:
 * allá se declara QUÉ puede pedir el modelo, acá CÓMO se ve.
 *
 * Están separados porque tienen consumidores distintos —el contrato viaja al
 * server, esto no— pero se editan juntos: **una primitiva nueva es una entrada
 * en cada uno**, y nada más en todo el repo.
 *
 * Una clave sin entrada acá no se dibuja. No es un caso imposible aunque el
 * contrato lo publique todo junto: el `use` viene de texto generado, y el
 * cliente es la última autoridad sobre lo que sabe pintar.
 */
export const VIEW_BLOCK_RENDERERS: Record<string, Component> = {
  'row-action': RowActionBlock,
}

export function rendererFor(use: string): Component | undefined {
  return VIEW_BLOCK_RENDERERS[use]
}
