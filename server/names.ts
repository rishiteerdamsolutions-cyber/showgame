/**
 * Card faces only (4 copies per name per active player in a round).
 * Player display names for the lobby and scores are separate — those are chosen when joining.
 * Maximum 10 players; the deck draws a random subset of this list of size = player count.
 */
export const FAMILY_CARD_NAMES: readonly string[] = [
  "RAMA",
  "SITA",
  "LAKSHMAN",
  "HANUMAN",
  "HE-MAN",
  "SUPERMAN",
  "JAMBA",
  "VAALI",
  "RAVAN",
  "JETAYU",
] as const;

export function assertConfiguredNames(): void {
  if (FAMILY_CARD_NAMES.length !== 10) {
    throw new Error("FAMILY_CARD_NAMES must contain exactly 10 entries.");
  }
}
