const MARKERS = [
  "</rationale>",
  "</description>",
  "</problem>",
  "</resolution>",
  "</alternatives>",
  "</governs>",
  "</invoke>",
  "<problem>",
  "<resolution>",
  "<alternatives>",
  "<governs>",
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
    for (const marker of MARKERS) {
      if (value.includes(marker)) {
        return { marker, field };
      }
    }
  }
  return null;
}
