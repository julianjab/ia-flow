/**
 * `blockedReport`: el reporte de una corrida que falló, para el `report` del `onError` del
 * proyecto (project.yaml): el motivo.
 */
import { defineMapper } from '@ia-flow/runner-v2/actions'

export default defineMapper({
  id: 'blockedReport',
  map: (err) => ({ summary: `La corrida falló: ${err.message}`, validations: [] }),
})
