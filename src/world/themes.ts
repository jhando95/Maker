/**
 * Three maps from one neighbourhood: the season is the map.
 *
 * A second full layout would need every mode's anchors — flags, spawns, water,
 * nav — rebuilt and rebalanced. What actually makes a yard read as a different
 * *place* is cheaper and travels for free: the vegetation, the ground, and
 * the light they sit in. So a map is a theme over the same bones, and the
 * theme rides INSIDE the seed string ("autumn!1234") — the seed already
 * reaches every guest, so two machines can no more disagree about the season
 * than about where the fence is.
 */

export interface MapTheme {
  readonly id: string;
  readonly name: string;
  readonly grass: number;
  readonly grassDark: number;
  readonly foliage: number;
  readonly foliageDark: number;
  readonly canopy: readonly [number, number, number];
}

export const THEMES: readonly MapTheme[] = [
  {
    id: 'backyard', name: 'Summer Backyard',
    grass: 0x7fb84a, grassDark: 0x63963a,
    foliage: 0x4f9a3a, foliageDark: 0x3d7a2c,
    canopy: [0x4f9a3a, 0x3d7a2c, 0x5aa845],
  },
  {
    id: 'autumn', name: 'Autumn Lane',
    grass: 0xa8a04e, grassDark: 0x8a7f3c,
    foliage: 0xd8842f, foliageDark: 0xb45a24,
    canopy: [0xd8842f, 0xc9603f, 0xe8b03c],
  },
  {
    id: 'winter', name: 'Winter Morning',
    grass: 0xdfe8ea, grassDark: 0xc2d2d8,
    foliage: 0x3a6248, foliageDark: 0x2c4a38,
    canopy: [0x3a6248, 0x2c4a38, 0x476e52],
  },
] as const;

/**
 * The theme a seed names, or summer. "autumn!1234" is autumn's yard 1234;
 * a seed with no prefix (every existing seed) is the summer everyone knows.
 */
export function themeOf(seed: string | number): MapTheme {
  const text = String(seed);
  const bang = text.indexOf('!');
  if (bang > 0) {
    const found = THEMES.find((t) => t.id === text.slice(0, bang));
    if (found !== undefined) return found;
  }
  return THEMES[0]!;
}

/** The seed that names a theme: what a menu hands the world. */
export function themedSeed(themeId: string, seed: string): string {
  return themeId === 'backyard' ? seed : `${themeId}!${seed}`;
}
