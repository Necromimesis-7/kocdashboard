import type { FetchFrequency } from "@koc-dashboard/shared";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function computeNextFetchAt(frequency: FetchFrequency | null, from = new Date()): Date | null {
  if (!frequency) {
    return null;
  }

  const intervalDays = frequency === "daily" ? 1 : frequency === "every_2_days" ? 2 : 7;
  return new Date(from.getTime() + intervalDays * ONE_DAY_MS);
}
