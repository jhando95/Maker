import { describe, it, expect } from 'vitest';
import { forceVisible, warmUp, type Hideable, type Compiler } from './warmup.ts';

/** A tree with a visibility flag, which is the whole of what the rule is about. */
class Node implements Hideable {
  visible: boolean;
  count?: number;
  readonly children: Node[];
  constructor(readonly name: string, visible = true, children: Node[] = [], count?: number) {
    this.visible = visible;
    this.children = children;
    this.count = count;
  }
  traverse(callback: (object: Hideable) => void): void {
    callback(this);
    for (const child of this.children) child.traverse(callback);
  }
  /** The visibility of the whole tree, as a string, so a diff reads. */
  get shape(): string {
    const parts: string[] = [];
    this.traverse((o) => parts.push(`${(o as Node).name}${o.visible ? '+' : '-'}`));
    return parts.join(' ');
  }
}

const tree = () =>
  new Node('scene', true, [
    new Node('lawn', true),
    new Node('flags', false, [new Node('red', true), new Node('blue', false)]),
    new Node('lamps', false),
  ]);

describe('showing everything for the length of a compile', () => {
  it('reaches what is hidden, which is the whole point', () => {
    // Handed the scene as it stands, `compile` warms the two things already on
    // screen and leaves every hitch where it was.
    const root = tree();
    forceVisible(root);
    expect(root.shape).toBe('scene+ lawn+ flags+ red+ blue+ lamps+');
  });

  it('descends into a hidden subtree rather than stopping at it', () => {
    // A renderer stops at a hidden branch; this must not, or the objects that
    // matter most — the ones inside a hidden group — stay uncompiled.
    const root = tree();
    forceVisible(root);
    const blue = root.children[1]!.children[1]!;
    expect(blue.visible).toBe(true);
  });

  it('puts back exactly what was off', () => {
    const root = tree();
    const before = root.shape;
    forceVisible(root)();
    expect(root.shape).toBe(before);
  });

  it('does not switch anything on that a restore should have left off', () => {
    // The failure worth guarding: a restore that sets everything visible leaves
    // a flag floating over an empty lawn, which is worse than the stutter.
    const root = tree();
    forceVisible(root)();
    expect(root.children[2]!.visible).toBe(false);
    expect(root.children[1]!.visible).toBe(false);
  });

  it('leaves an already-visible object alone', () => {
    const root = tree();
    forceVisible(root)();
    expect(root.children[0]!.visible).toBe(true);
    expect(root.children[1]!.children[0]!.visible).toBe(true);
  });

  it('can be restored twice without hiding more', () => {
    const root = tree();
    const restore = forceVisible(root);
    restore();
    root.children[2]!.visible = true;
    restore();
    expect(root.children[2]!.visible).toBe(true);
  });

  it('costs nothing on a scene with nothing hidden', () => {
    const root = new Node('scene', true, [new Node('lawn', true)]);
    const before = root.shape;
    forceVisible(root)();
    expect(root.shape).toBe(before);
  });
});

/**
 * A renderer that records what it was shown, and nothing else.
 *
 * It honours visibility on both passes, because a fake that ignored it would
 * pass with the bug this whole file exists to prevent still in place.
 */
function fakeCompiler(programsAfter = 9) {
  let programs = 4;
  const seen: string[] = [];
  const drawn: string[] = [];
  /** Every change to the shadow flag, in order, with what the scene looked like. */
  const log: string[] = [];
  const shadowMap = {
    _needs: false,
    get needsUpdate() { return this._needs; },
    set needsUpdate(v: boolean) {
      this._needs = v;
      log.push(`shadow=${v}`);
    },
  };
  const compiler: Compiler = {
    compile: (scene) => {
      (scene as Node).traverse((o) => {
        if (o.visible) seen.push((o as Node).name);
      });
      programs = programsAfter;
      log.push('compile');
      return undefined;
    },
    render: (scene) => {
      (scene as Node).traverse((o) => {
        // A renderer skips a hidden object and an instanced mesh at zero alike.
        // A fake that only honoured the first would pass with the bug in place.
        if (o.visible && o.count !== 0) drawn.push((o as Node).name);
      });
      log.push('render');
      // What three does once it has drawn the map: the request is spent. Without
      // this the flag is left true by the *first* assignment and the assertion
      // that the map is invalidated on the way out cannot fail — which is how it
      // was written, and the plant pass is what said so.
      shadowMap._needs = false;
    },
    shadowMap,
    get info() {
      return { programs: { length: programs } };
    },
  };
  return { compiler, seen, drawn, log, shadowMap, get programs() { return programs; } };
}

describe('an instanced mesh at zero, which is skipped just as a hidden one is', () => {
  // The rule this project has written up twice, in two other files, about two
  // other bugs: `count` is a number handed to the draw call. Every character
  // mesh sits at zero on a title screen, so a warm-up that lifted only
  // `visible` compiled everything in the world except the cast.
  const cast = () =>
    new Node('scene', true, [
      new Node('kids', true, [], 0),
      new Node('planks', true, [], 12),
      new Node('lamps', false, [], 0),
    ]);

  it('raises a count of zero so the draw actually happens', () => {
    const root = cast();
    forceVisible(root);
    expect(root.children[0]!.count).toBe(1);
    expect(root.children[2]!.count).toBe(1);
  });

  it('leaves a count that was already drawing alone', () => {
    const root = cast();
    forceVisible(root);
    expect(root.children[1]!.count).toBe(12);
  });

  it('puts the counts back', () => {
    const root = cast();
    forceVisible(root)();
    expect(root.children.map((c) => c.count)).toEqual([0, 12, 0]);
  });

  it('shows the compiler a cast that was at zero', () => {
    const f = fakeCompiler();
    warmUp(f.compiler, cast(), {});
    expect(f.drawn).toContain('kids');
  });
});

describe('warming the whole scene', () => {
  it('shows the compiler the objects that were hidden', () => {
    const f = fakeCompiler();
    warmUp(f.compiler, tree(), {});
    expect(f.seen).toEqual(['scene', 'lawn', 'flags', 'red', 'blue', 'lamps']);
  });

  it('leaves the scene the way it found it', () => {
    const root = tree();
    const before = root.shape;
    warmUp(fakeCompiler().compiler, root, {});
    expect(root.shape).toBe(before);
  });

  it('reports what it compiled and what it had to reveal', () => {
    const result = warmUp(fakeCompiler(9).compiler, tree(), {});
    expect(result.before).toBe(4);
    expect(result.after).toBe(9);
    // `flags`, `blue` and `lamps` — including the one nested inside a hidden
    // branch, which is the count that would be wrong if traversal stopped.
    expect(result.revealed).toBe(3);
  });

  it('restores even when the driver throws', () => {
    // A compile that dies with every hidden object switched on is a far more
    // visible failure than the stutter this exists to prevent.
    const root = tree();
    const before = root.shape;
    const shadowMap = { needsUpdate: false };
    const compiler: Compiler = {
      compile: () => { throw new Error('driver said no'); },
      render: () => {},
      shadowMap,
      info: { programs: { length: 4 } },
    };
    expect(() => warmUp(compiler, root, {})).toThrow('driver said no');
    expect(root.shape).toBe(before);
    // And the shadow map is still invalidated, or a warm-up that died half way
    // leaves a map drawn from a scene that no longer exists.
    expect(shadowMap.needsUpdate).toBe(true);
  });

  it('draws one frame, so the shadow programs exist too', () => {
    // `compile` warms the pass that draws to the screen. A shadow map is a
    // second pass with its own material per caster, and the only way to compile
    // a pass is to run it — measured: sixteen programs at boot and starting Tag
    // still compiled a seventeenth whose cache key began `depth`.
    const f = fakeCompiler();
    warmUp(f.compiler, tree(), {});
    expect(f.drawn).toEqual(['scene', 'lawn', 'flags', 'red', 'blue', 'lamps']);
  });

  it('asks for the shadow map before drawing it, not after', () => {
    // A render with the flag still down reuses the map from boot and compiles
    // no depth material at all, which is the whole reason for the frame.
    const f = fakeCompiler();
    warmUp(f.compiler, tree(), {});
    expect(f.log.slice(0, 4)).toEqual(['compile', 'shadow=true', 'render', 'shadow=true']);
  });

  it('leaves the shadow map invalid, because the one it drew is a lie', () => {
    // It contains a shadow for every hidden object in the world. This map is
    // static — nothing rebuilds it until somebody builds something — so the
    // shadow of a flag would sit on a lawn with no flag on it all round.
    const f = fakeCompiler();
    warmUp(f.compiler, tree(), {});
    expect(f.shadowMap.needsUpdate).toBe(true);
    expect(f.log[f.log.length - 1]).toBe('shadow=true');
  });

  it('survives a renderer that reports no programs at all', () => {
    const compiler: Compiler = {
      compile: () => undefined,
      render: () => {},
      shadowMap: { needsUpdate: false },
      info: { programs: null },
    };
    const result = warmUp(compiler, tree(), {});
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
  });
});
