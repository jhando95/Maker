/**
 * Kit palettes: Shed Day with a smaller box of parts.
 *
 * A constraint is a prompt — hand somebody every part and they build what
 * they always build; hand them planks only and they invent. The kit is a
 * filter over which parts the picker, the hotbar and the cycler will hand
 * you; it spends no new art and adds no new rules, which is what makes it an
 * afternoon rather than a feature. Parts already placed are never touched:
 * a kit narrows the hand, not the world.
 */

export interface Kit {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** Allowed indices into PART_KINDS, or null for everything. */
  readonly kinds: readonly number[] | null;
}

export const KITS: readonly Kit[] = [
  { id: 'shed', name: 'The Whole Shed', blurb: 'Every part there is.', kinds: null },
  { id: 'lumber', name: 'Lumberyard', blurb: 'Planks, beams and posts. Frames and bridges.', kinds: [0, 1, 2, 3, 4] },
  { id: 'mason', name: 'Panels & Blocks', blurb: 'Walls, ramps and solid mass.', kinds: [5, 6, 7] },
  { id: 'planks', name: 'Planks Only', blurb: 'Three planks. Invent.', kinds: [0, 1, 2] },
] as const;
