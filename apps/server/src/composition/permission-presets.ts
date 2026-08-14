// Permission presets — the 5 built-in role bundles agents can pick from.
// Presets live in code (not DB) so the shape can evolve with the sandbox
// engine without a migration. `AgentDefinition.presetId` stores the id;
// `compilePolicy` in application/policy.ts expands it at dispatch time.
//
// New preset? Add it here + wire it into `PRESET_BY_ID` + `ALL_PRESETS` +
// the enum in `packages/shared/src/schemas.ts::PermissionPresetIdSchema`.

import type { Permission, PermissionPresetId } from '@ia-flow/shared'

export interface PermissionPresetDef {
  id: PermissionPresetId
  description: string
  permissions: readonly Permission[]
}

// `reader`: puramente lectura + puede mover el issue de status. No escribe
// ni fs ni comments — pensado para bots que sólo triage/labeling vía status.
export const READER_PRESET: PermissionPresetDef = {
  id: 'reader',
  description: 'Lectura del repo + transiciones de status. Sin escritura ni bash.',
  permissions: ['fs.read', 'task.transition'],
}

// `refiner`: agrega escritura de tarea (edita PRD, agrega comentarios) al
// reader. Sigue sin filesystem write ni bash — el refiner opera sobre la
// tarea, no sobre el código.
export const REFINER_PRESET: PermissionPresetDef = {
  id: 'refiner',
  description: 'Refina la tarea (edita PRD, comentarios) + lectura del repo.',
  permissions: ['fs.read', 'task.write', 'task.transition'],
}

// `implementer`: el rol completo de coding — fs read/write, task lifecycle,
// workspace, y bash con bun + shell generico + git task-branch. Sin `gh`,
// sin push a main.
export const IMPLEMENTER_PRESET: PermissionPresetDef = {
  id: 'implementer',
  description: 'Coding end-to-end sobre una task branch. Sin gh, sin push a main.',
  permissions: [
    'fs.read',
    'fs.write',
    'task.write',
    'task.transition',
    'workspace',
    'bash:bun',
    'bash:shell.generic',
    'bash:git.readonly',
    'bash:git.write.task',
  ],
}

// `reviewer`: implementer + `gh` (para crear/comentar/mergear PRs vía CLI).
// Sigue sin `git.write.main` — el reviewer NUNCA pushea directo a main; si
// necesita mergear lo hace vía `gh pr merge`.
export const REVIEWER_PRESET: PermissionPresetDef = {
  id: 'reviewer',
  description: 'Implementer + gh CLI (PR review/merge). Sin push directo a main.',
  permissions: [...IMPLEMENTER_PRESET.permissions, 'bash:gh'],
}

// `releaser`: reviewer + push directo a main / release branches. Reservado
// para hotfixers / release cutters — el resto usa `reviewer`.
export const RELEASER_PRESET: PermissionPresetDef = {
  id: 'releaser',
  description: 'Reviewer + push directo a main / release/* (hotfixer / release cutter).',
  permissions: [...REVIEWER_PRESET.permissions, 'bash:git.write.main'],
}

export const ALL_PRESETS: PermissionPresetDef[] = [
  READER_PRESET,
  REFINER_PRESET,
  IMPLEMENTER_PRESET,
  REVIEWER_PRESET,
  RELEASER_PRESET,
]

export const PRESET_BY_ID: Record<PermissionPresetId, PermissionPresetDef> = {
  reader: READER_PRESET,
  refiner: REFINER_PRESET,
  implementer: IMPLEMENTER_PRESET,
  reviewer: REVIEWER_PRESET,
  releaser: RELEASER_PRESET,
}
