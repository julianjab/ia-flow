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

// GitHub rejects a label name over this many characters (422) and a label
// can't contain a newline. Both are enforced in labelFor() so a bad value
// never reaches the API — GitHubIssueTaskSource.setFields batches every
// field of a call into ONE persistLabels() write, so a rejected write here
// would have failed the whole batch, including an unrelated Status change
// riding along in the same call.
const MAX_LABEL_LENGTH = 50

export interface ParsedFieldLabel {
  name: string
  value: string
}

export class FieldLabelCodec {
  private readonly prefix: string

  constructor(prefix: string = FIELD_PREFIX) {
    this.prefix = prefix.toLowerCase()
  }

  /**
   * `name` may NOT contain '=': `parse()` splits on the FIRST '=' in the
   * label, so a name containing one would desync name/value on read-back —
   * `labelFor('a=b', 'c')` would parse back as `{name: 'a', value: 'b=c'}`,
   * silently corrupting the field this call intended to write AND colliding
   * with (overwriting on the next write, or being overwritten by) a
   * legitimately-named field `a`.
   *
   * `value` is defensively stripped of newlines (a label is a single-line
   * tag) and truncated to fit GitHub's 50-char label cap — never rejected,
   * so a too-long field value degrades to a truncated label instead of
   * taking down the whole batched write. Use `wouldTruncate()` beforehand if
   * the caller wants to log when that happens.
   */
  labelFor(name: string, value: string): string {
    if (name.includes('=')) {
      throw new Error(`FieldLabelCodec: field name '${name}' cannot contain '='`)
    }
    const head = `${this.prefix}${name}=`
    if (head.length >= MAX_LABEL_LENGTH) {
      throw new Error(
        `FieldLabelCodec: field name '${name}' alone exceeds the ${MAX_LABEL_LENGTH}-char GitHub label limit`,
      )
    }
    const cleanValue = value.replace(/[\r\n]+/g, ' ')
    const maxValueLen = MAX_LABEL_LENGTH - head.length
    return head + cleanValue.slice(0, maxValueLen)
  }

  /** True when `labelFor(name, value)` would have to shorten `value` to fit
   * GitHub's label cap — lets a caller with a logger (GitHubIssueTaskSource)
   * warn about the truncation instead of it happening silently. */
  wouldTruncate(name: string, value: string): boolean {
    const head = `${this.prefix}${name}=`
    const cleanValue = value.replace(/[\r\n]+/g, ' ')
    return cleanValue.length > MAX_LABEL_LENGTH - head.length
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
