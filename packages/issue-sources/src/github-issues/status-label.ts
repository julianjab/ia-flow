// GitHub issues have no native "Status" field (that's a Projects v2 concept —
// see github-project/source.ts). This encodes the pipeline status as a label
// with a fixed prefix, so applyTransition/when/onFinish/onError — already
// provider-agnostic in the engine — work unmodified against a plain issue.
//
// One label at a time: `withStatus` drops any existing `status:*` label
// before adding the new one, mirroring how a Project's Single-Select field
// only ever holds one value.
const STATUS_PREFIX = 'status:'

/** Anti-doble-procesamiento — el equivalente label del campo "Working" de un
 * GitHub Project (ver GitHubTaskSource.setAgentWorking). */
export const WORKING_LABEL = 'ia-flow:working'

export class StatusLabelCodec {
  constructor(private readonly prefix: string = STATUS_PREFIX) {}

  /** '' when no status label is present — callers treat that as "no status". */
  statusFromLabels(labels: string[]): string {
    const match = labels.find((l) => l.toLowerCase().startsWith(this.prefix))
    return match ? match.slice(this.prefix.length) : ''
  }

  labelFor(status: string): string {
    return `${this.prefix}${status}`
  }

  /** Returns `labels` with any existing status label replaced by `newStatus`. */
  withStatus(labels: string[], newStatus: string): string[] {
    const withoutStatus = labels.filter((l) => !l.toLowerCase().startsWith(this.prefix))
    return [...withoutStatus, this.labelFor(newStatus)]
  }
}

/** Tracked = has the project's anchor label (config.anchorLabel) — the filter
 * that keeps this source from sweeping every open issue in the repo. */
export function isTracked(labels: string[], anchorLabel: string): boolean {
  return labels.includes(anchorLabel)
}

export function withWorking(labels: string[], working: boolean): string[] {
  const without = labels.filter((l) => l !== WORKING_LABEL)
  return working ? [...without, WORKING_LABEL] : without
}
