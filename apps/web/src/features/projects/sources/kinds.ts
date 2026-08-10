// The source kinds the picker offers to the user. Projects can still hold
// kinds outside this list (e.g. one registered server-side without a matching
// web form) — SourceFormSwitch surfaces the current kind as a read-only
// option so the user can see it before switching away.
export const SUPPORTED_KINDS = ['github', 'local'] as const

export type SupportedKind = (typeof SUPPORTED_KINDS)[number]
