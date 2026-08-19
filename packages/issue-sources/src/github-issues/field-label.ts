// GitHub issues have no native custom-field concept (that's a Projects v2
// board column) — a plain enum-ish field value (Priority=high, Size=M) gets
// encoded as a label with this prefix, same idea as StatusLabelCodec but
// key=value instead of a bare status name.
//
// Only fits short, comma/newline-free values: GitHub caps a label name at 50
// characters. Free-form text (a long note, a paragraph) needs a different
// mechanism entirely (e.g. metadata embedded in the issue body) — this one
// is for the "Priority: high" / "Size: M" shape of field, not prose.
const FIELD_PREFIX = 'field:'

export interface ParsedFieldLabel {
  name: string
  value: string
}

export class FieldLabelCodec {
  private readonly prefix: string

  constructor(prefix: string = FIELD_PREFIX) {
    this.prefix = prefix.toLowerCase()
  }

  labelFor(name: string, value: string): string {
    return `${this.prefix}${name}=${value}`
  }

  /** `null` when `label` isn't one of this codec's field labels (wrong
   * prefix, or missing the `=` separator). */
  parse(label: string): ParsedFieldLabel | null {
    if (!label.toLowerCase().startsWith(this.prefix)) return null
    const rest = label.slice(this.prefix.length)
    const eq = rest.indexOf('=')
    if (eq < 0) return null
    return { name: rest.slice(0, eq), value: rest.slice(eq + 1) }
  }

  /** All field labels on an issue as a name→value map — feeds `task.fields`
   * so `when` conditions and `{{task.fields.*}}` read a github-issues field
   * exactly like a GitHub Project custom column. */
  fieldsFromLabels(labels: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const label of labels) {
      const parsed = this.parse(label)
      if (parsed) out[parsed.name] = parsed.value
    }
    return out
  }

  /** Replaces any existing `field:<name>=*` label (case-insensitive name
   * match) with the new value, leaving every other label — including other
   * fields — untouched. */
  withField(labels: string[], name: string, value: string): string[] {
    const wanted = name.toLowerCase()
    const withoutField = labels.filter((l) => this.parse(l)?.name.toLowerCase() !== wanted)
    return [...withoutField, this.labelFor(name, value)]
  }
}
