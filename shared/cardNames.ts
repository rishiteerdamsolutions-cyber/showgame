/**
 * Ten Marvel Universe hero codenames — card faces (four copies per name per seated player in the deck).
 * 5 popular male + 5 popular female (MCU / mainstream recognition). Single source for server + client.
 */
export const MARVEL_CARD_NAMES = [
  "SPIDERMAN",
  "IRONMAN",
  "THOR",
  "BLACKPANTHER",
  "DRSTRANGE",
  "BLACKWIDOW",
  "SCARLETWITCH",
  "CAPTAINMARVEL",
  "STORM",
  "GAMORA",
] as const;

export type MarvelCardToken = (typeof MARVEL_CARD_NAMES)[number];

/** Readable labels shown on cards and in UI copy */
export const CARD_FACE_LABELS: Record<MarvelCardToken, string> = {
  SPIDERMAN: "Spider-Man",
  IRONMAN: "Iron Man",
  THOR: "Thor",
  BLACKPANTHER: "Black Panther",
  DRSTRANGE: "Doctor Strange",
  BLACKWIDOW: "Black Widow",
  SCARLETWITCH: "Scarlet Witch",
  CAPTAINMARVEL: "Captain Marvel",
  STORM: "Storm",
  GAMORA: "Gamora",
};

export function labelForCardFace(token: string): string {
  return (CARD_FACE_LABELS as Record<string, string>)[token] ?? token;
}

/** CSS modifier e.g. card5--spiderman */
export function slugForCardFace(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}
