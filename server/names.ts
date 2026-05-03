import { MARVEL_CARD_NAMES } from "../shared/cardNames";

/**
 * Card faces only (4 copies per name per active player in a round).
 * Player display names for the lobby are chosen when joining.
 */
export const FAMILY_CARD_NAMES: readonly string[] = MARVEL_CARD_NAMES;

export function assertConfiguredNames(): void {
  if (FAMILY_CARD_NAMES.length !== 10) {
    throw new Error("FAMILY_CARD_NAMES must contain exactly 10 entries.");
  }
}
