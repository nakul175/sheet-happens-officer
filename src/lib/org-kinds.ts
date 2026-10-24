/** User-facing classifications are also their persisted canonical values. */
export const ORGANISATION_KINDS = [
  "Donor", "Ministry", "Public Institution", "Multilateral", "Implementation Partner",
  "Academic Institution", "Private Institution", "Others",
] as const;

/** Keep an existing custom classification intact until an explicit replacement is chosen. */
export function organisationKindOptions(current: string | null = null): readonly string[] {
  return current && !ORGANISATION_KINDS.some((kind) => kind === current)
    ? [current, ...ORGANISATION_KINDS]
    : ORGANISATION_KINDS;
}
