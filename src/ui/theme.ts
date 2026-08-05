/**
 * One visual language for everything on top of the canvas.
 *
 * The HUD and the menus were each styled where they were written, which is how
 * you end up with two greys, three corner radii and a panel that looks like a
 * different program depending on which screen you are on. These are the tokens
 * both consume, so a change lands everywhere or nowhere.
 *
 * ## Where the look comes from
 *
 * The world is cel-shaded and every solid thing in it has a hard dark outline
 * drawn round it. So the interface is outlined the same way: **hard borders and
 * hard offset shadows, never a blur.** That one rule is most of the identity. A
 * translucent dark panel with a backdrop blur — which is what this used to be,
 * and what most games ship — reads as a layer of glass someone put in front of
 * the game. An outlined card reads as an object made of the same stuff as the
 * fence and the treehouse, which is the point: a backyard game where the kids
 * built everything should have a HUD that looks like they built that too.
 *
 * The corollary is that nothing here uses `backdrop-filter`. That is a
 * deliberate loss — it genuinely helps legibility over a busy scene — paid for
 * with heavier outlines and stronger contrast instead, which cost nothing on a
 * software rasterizer and never smear the thing you are aiming at.
 *
 * ## Colour
 *
 * Warm, because the game is a hot afternoon. The accents are not decoration:
 * `--team-left` and `--team-right` are the exact shirt colours the renderer
 * uses, so a score in your colour and a kid in your colour are obviously the
 * same fact. Wiring the UI to the world's palette rather than to a palette of
 * its own is what stops the two drifting the next time either moves.
 */

export const THEME = `
:root {
  /* The outline colour, matching the world's own outline pass. */
  --ink: #2b201c;
  --ink-soft: rgba(43, 32, 28, 0.62);

  /* Surfaces. Dark by default: the game is bright and mostly sky and grass. */
  --panel: #34272200;
  --panel-solid: #3a2b25;
  --panel-fill: rgba(48, 35, 30, 0.82);
  --panel-raised: rgba(62, 46, 39, 0.92);
  /* Cardboard, for the things that should read as made rather than rendered. */
  --card: #f2e2c4;
  --card-edge: #d8c19a;

  --text: #fff6e9;
  --text-dim: rgba(255, 246, 233, 0.66);

  /* Accents. */
  --sun: #ffc247;
  --water: #6ec6ff;
  --alarm: #ff8358;
  --go: #8fd16a;
  /* The two sides, exactly as the renderer paints their shirts. */
  --team-left: #7a3fc8;
  --team-right: #e07a4f;

  /* One radius family, so nothing is nearly-but-not-quite square. */
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 16px;

  /*
   * The outline, and the hard shadow under it.
   *
   * Offset with zero blur on purpose — a blurred shadow is a lighting effect and
   * this world has no soft light in it. The offset is what makes a panel read as
   * a card lying on top rather than a rectangle painted on.
   */
  --edge: 2px solid var(--ink);
  --drop: 0 3px 0 var(--ink-soft);
  --drop-lg: 0 5px 0 var(--ink-soft);

  /* Type. */
  --font: ui-rounded, "Nunito", "Trebuchet MS", "Segoe UI", system-ui, sans-serif;
  /*
   * A hard text outline, for anything that has to sit straight on the scene
   * with no panel behind it. Four offsets rather than a shadow, because the
   * text needs to survive being over pale sky and dark grass in the same word.
   */
  --text-edge: -2px 0 var(--ink), 2px 0 var(--ink), 0 -2px var(--ink), 0 2px var(--ink),
    -2px -2px var(--ink), 2px -2px var(--ink), -2px 2px var(--ink), 2px 2px var(--ink),
    0 4px 0 rgba(43, 32, 28, 0.4);

  /*
   * Motion. Short, and with a little overshoot on anything that arrives —
   * a card being slapped down, not a dialog fading in.
   */
  --pop: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
}

/* Everything on top of the canvas shares these. */
.mk-surface {
  background: var(--panel-fill);
  border: var(--edge);
  border-radius: var(--r-md);
  box-shadow: var(--drop);
}

.mk-outlined-text {
  text-shadow: var(--text-edge);
}

/* Numbers that change every frame must not reflow the thing around them. */
.mk-tabular {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}

@keyframes mk-pop-in {
  from { transform: scale(0.86); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

@keyframes mk-drop-in {
  from { transform: translateY(-14px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/*
 * Respect a player who has asked for less movement.
 *
 * Not a courtesy. This HUD pops, shakes and slides, and for a player with
 * vestibular sensitivity that is the difference between a game they can play
 * and one they cannot.
 */
@media (prefers-reduced-motion: reduce) {
  .maker-hud *, .maker-menu * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

/** Install once. Idempotent, so a second HUD in a test does not double it. */
export function installTheme(): void {
  if (document.getElementById('maker-theme') !== null) return;
  const style = document.createElement('style');
  style.id = 'maker-theme';
  style.textContent = THEME;
  document.head.appendChild(style);
}
