import type { Capture } from '../capture.js';
import { STREAM_IDS } from '../registry.js';

/**
 * Cross-check a capture's manifest against its stream payloads. The manifest is the source of truth
 * for "what was collected and why"; a stream marked `present` must carry data, and a stream with any
 * other status (`unsupported` / `not-requested` / `dropped` / `policy-blocked`) must NOT — otherwise
 * the "unknown != zero" contract is silently broken (e.g. `profile: present` with no profile block,
 * or data attached to a stream the manifest says was `dropped`).
 *
 * The codec round-trips whatever it is handed without judging it (pack must stay cheap on the page),
 * so this check is intentionally SEPARATE: use it in tests, in tooling that ingests captures, and as
 * a development guard — never on the hot pack path. Returns a list of human-readable problems; an
 * empty array means the manifest and payloads agree.
 */
export function checkConsistency(capture: Capture): string[] {
  const issues: string[] = [];
  for (const id of STREAM_IDS) {
    const status = capture.manifest.streams[id].status;
    const hasData = capture.streams[id] !== undefined;
    if (status === 'present' && !hasData) {
      issues.push(`stream "${id}" is manifest-present but carries no data`);
    } else if (status !== 'present' && hasData) {
      issues.push(`stream "${id}" carries data but its manifest status is "${status}" (expected "present")`);
    }
  }
  return issues;
}
