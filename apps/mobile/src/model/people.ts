/**
 * Who does what, in plain words. Approvals always go to "the other spouse" (equal by design), but fixing an entry
 * that is already in the books is the bookkeeper's job in Business Central through the Console (Phase 1, V4 and
 * C1): that is Cade for this family, configurable for a client household (EXPO_PUBLIC_BOOKKEEPER_NAME).
 */
import { env } from "../lib/env";

export function bookkeeperName(): string {
  return env.bookkeeperName;
}

/** First names compared, so "Cade Jones" from an Entra id token still matches "Cade". */
function isBookkeeper(memberName: string | undefined): boolean {
  const first = (s: string | undefined) => (s ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first(memberName) !== "" && first(memberName) === first(bookkeeperName());
}

/** "Cade will fix it in the books" — or, when Cade himself flags it, where he will find it. */
export function booksFixWords(memberName: string | undefined): string {
  return isBookkeeper(memberName) ? "it's in your Console queue to fix in the books" : `${bookkeeperName()} will fix it in the books`;
}

/** Who sees a business mark: the bookkeeper's CTJ/lash list. */
export function businessSeenBy(memberName: string | undefined): string {
  return isBookkeeper(memberName) ? "it's on your Console list" : `${bookkeeperName()} will see it`;
}

/** The FAMILY_AREA dimension value for a member ("Vanessa" or "Vanessa Jones" -> "VANESSA"), for the "Mine" filter. */
export function familyAreaOf(displayName: string | undefined): string {
  return (displayName ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
}
