const MARKERS = [
  "<problem>",
  "<resolution>",
  "<alternatives>",
  "<governs>",
  "</rationale>",
  "</description>",
  "</problem>",
  "</resolution>",
  "</alternatives>",
  "</governs>",
  "</invoke>",
] as const;

const SCANNED_FIELDS = [
  "title",
  "description",
  "rationale",
  "problem",
  "resolution",
] as const;

export function validateDecisionFields(
  input: Record<string, unknown>,
): { marker: string; field: string } | null {
  for (const field of SCANNED_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;

    // Find the earliest marker position in this field
    let earliestPosition = Infinity;
    let earliestMarker: string | null = null;

    for (const marker of MARKERS) {
      const position = value.indexOf(marker);
      if (position !== -1 && position < earliestPosition) {
        earliestPosition = position;
        earliestMarker = marker;
      }
    }

    if (earliestMarker !== null) {
      return { marker: earliestMarker, field };
    }
  }
  return null;
}
