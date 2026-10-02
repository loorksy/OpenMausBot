import { utcTimestampSchema } from "../../../shared/trading/ids.ts";

/** Age between two caller-supplied instants. This does not read the wall clock. */
export function ageMillis(earlier: string, later: string): number | "bad" {
  if (!utcTimestampSchema.safeParse(earlier).success) return "bad";
  if (!utcTimestampSchema.safeParse(later).success) return "bad";
  return Date.parse(later) - Date.parse(earlier);
}
