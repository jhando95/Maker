/**
 * Compile everything before anybody is watching.
 *
 * WebGL compiles a shader program the first time a material is *drawn*, not
 * when it is made — which is why `scenarios/soak.mjs` watches the program count
 * climb during its first dozen rounds and then stop. Every one of those is a
 * frame where the driver stopped to compile, and on a real machine that is the
 * hitch a player gets the first time a flag appears, the first time somebody
 * sprays a shape nobody has sprayed, the first time it gets dark. It is the
 * single most common stutter in modern games and it has one fix: compile it all
 * up front, while a loading screen is on the glass and nobody can tell.
 *
 * `WebGLRenderer.compile` does exactly that and has one trap, which is most of
 * why this file exists.
 *
 * ## It skips everything that is hidden, and hidden is the whole point
 *
 * `compile` walks the scene the way a render does, and a render does not
 * descend into `visible === false`. But hidden is precisely the state of
 * everything worth warming: the flags, the crates, the balloons, the lamp glow
 * and the tag shapes are all built at boot and hidden until something makes
 * them matter. Handed the scene as it stands, `compile` warms the lawn and the
 * fence — the two things already on screen — and leaves every hitch exactly
 * where it was, while reporting that it compiled the scene.
 *
 * So everything is forced visible for the length of the call and put back
 * afterwards. Put back *exactly*: the restore re-hides the set that was hidden
 * rather than assuming a default, because a warm-up that leaves one marker
 * showing is a flag floating over an empty lawn, and that is a worse bug than
 * the stutter it was fixing.
 *
 * ## Hidden is not the only way to be skipped
 *
 * An instanced mesh with `count === 0` is skipped exactly as a hidden one is —
 * a rule this project has already written up twice, in two other files, about
 * two other bugs. Every character mesh sits at zero on a title screen, so a
 * warm-up that lifted only `visible` compiled everything in the world except
 * the cast, and the cast is the most expensive thing in it.
 *
 * ## And `compile` alone is not enough, which took a measurement to find
 *
 * With the hidden objects reached, sixteen programs compiled at boot and
 * starting Tag still compiled one more. Its cache key begins `depth`: it is a
 * **shadow** program. `compile` warms the pass that draws to the screen, and a
 * shadow map is a second pass with its own material for every caster — so a
 * caster nobody has seen still stops the driver the first time it throws a
 * shadow, which is the moment it appears.
 *
 * The only way to compile a pass is to run it, so the warm-up renders one
 * frame with everything visible. Two consequences, both handled here rather
 * than left to the caller: the frame lands on the canvas, which is why this is
 * called before the loop starts and while the title screen covers it; and the
 * shadow map it leaves behind contains shadows of every hidden object in the
 * world, so it is invalidated on the way out and rebuilt from the restored
 * scene on the first real frame.
 */

/**
 * The slice of `Object3D` this needs.
 *
 * A tree with a visibility flag, which is all the rule is about. Declared
 * rather than imported so the save-and-restore can be driven by a test on a
 * three-node tree, where getting it wrong is visible, instead of on a scene of
 * five hundred objects where it is not.
 */
export interface Hideable {
  visible: boolean;
  /**
   * Instances an instanced mesh will submit, where it is one.
   *
   * Part of being drawable and not an afterthought: this project has written up
   * twice that `count` is a number handed to the draw call, so a mesh at zero
   * is skipped exactly as a hidden one is. Every character in the game is an
   * instanced mesh sitting at zero until somebody is on the lawn, which makes
   * the cast the single largest thing a visibility-only warm-up would miss.
   */
  count?: number;
  traverse(callback: (object: Hideable) => void): void;
}

/**
 * Make everything drawable, and hand back the way to undo it.
 *
 * Two states stop an object reaching the driver and both have to be lifted:
 * `visible`, and — for an instanced mesh — a `count` of zero. Lifting only the
 * first is how the first version of this missed the entire cast, which is the
 * most expensive thing in the game to compile and the one thing guaranteed to
 * be at zero on a title screen.
 *
 * Records what it changed rather than every object: the restore has to put back
 * the set that was off, and a list of the ones already on is a list nobody
 * needs. It also means the cost is proportional to what was hidden rather than
 * to the size of the scene.
 */
export function forceVisible(root: Hideable): () => void {
  const hidden: Hideable[] = [];
  const empty: Hideable[] = [];
  root.traverse((object) => {
    if (!object.visible) {
      hidden.push(object);
      object.visible = true;
    }
    // One instance is enough to compile a program and cheap enough to draw. It
    // lands wherever the matrix at slot zero happens to point, which for a
    // fresh batch is the origin — invisible for the one frame this lasts, and
    // behind the title screen anyway.
    if (typeof object.count === 'number' && object.count === 0) {
      empty.push(object);
      object.count = 1;
    }
  });
  // Idempotent: calling it twice re-hides the same set rather than doing
  // anything the second time, because a caller that restores in a `finally` and
  // again on the happy path should not be a bug.
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const object of hidden) object.visible = false;
    for (const object of empty) object.count = 0;
  };
}

/** What the warm-up had to do, so a caller can say whether it was worth it. */
export interface WarmUp {
  /** Programs the renderer held before. */
  before: number;
  /** Programs it holds now. */
  after: number;
  /** Objects that were hidden and had to be shown to be reached. */
  revealed: number;
}

/** The bit of the renderer this needs, for the same reason as `Hideable`. */
export interface Compiler {
  compile(scene: object, camera: object): unknown;
  /** One frame, to compile the passes `compile` does not reach. */
  render(scene: object, camera: object): void;
  shadowMap: { needsUpdate: boolean };
  readonly info: { readonly programs?: { readonly length: number } | null };
}

/**
 * Compile every material in the scene, including the hidden ones.
 *
 * Synchronous on purpose. The asynchronous form spreads the work over frames,
 * which is right when the game is already running and wrong here: this is
 * called while a loading screen is up, where a long single stall is invisible
 * and a series of short ones is a stutter on the first thing a player sees.
 */
export function warmUp(renderer: Compiler, scene: Hideable, camera: object): WarmUp {
  const before = renderer.info.programs?.length ?? 0;
  let revealed = 0;
  scene.traverse((object) => {
    if (!object.visible) revealed++;
  });
  const restore = forceVisible(scene);
  try {
    renderer.compile(scene, camera);
    // And one frame, because a shadow program only exists once a shadow pass
    // has asked for it. Everything is still visible here, which is the point:
    // this compiles the depth material of every caster in the world, including
    // the ones a player will not see for another twenty minutes.
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
  } finally {
    // In a `finally` because a driver that throws mid-compile would otherwise
    // leave every hidden object in the world switched on, which is a far more
    // visible failure than the one this function exists to prevent.
    restore();
    // Always, and after the restore: the map just drawn has a shadow for every
    // hidden object in the world in it. Leaving that standing would put the
    // shadow of a flag on a lawn with no flag on it — and this map is static,
    // so it would stay there until somebody built something.
    renderer.shadowMap.needsUpdate = true;
  }
  return { before, after: renderer.info.programs?.length ?? 0, revealed };
}
