# Maker

A cel-shaded backyard building game. You get a pile of lumber and a lawn, and
you nail together whatever you want — ladders, staircases, towers, forts,
bridges. The long-term goal is party modes played *inside* the things you build:
capture the flag, water balloon battles, tag.

Single-player so far: one backyard, the movement and building mechanics the
whole game rests on, and the first game mode — **Fort Defense**. Build a fort,
then hold off waves of kids coming for your stash of water balloons.

```bash
npm install
npm run dev      # http://localhost:5173
```

## Controls

| | |
|---|---|
| `WASD` | move |
| `Space` | jump |
| `Shift` | sprint |
| `Ctrl` / `C` | crouch (also fine-placement mode while building) |
| `LMB` | place part — hold to keep placing |
| `RMB` | remove the part under the crosshair |
| `Alt` | free aim — suspend snapping entirely |
| `R` | cycle to the next snap candidate |
| `Q` / `E` | turn the held part 15° |
| `Z` / `X` | tilt / roll |
| `T` | reset rotation |
| `1`–`8`, wheel | choose a part |
| `Shift` + wheel | change colour |
| `V` | first ⇄ third person |
| `G` | repeat the last step — hold to run a chain |
| `Esc` | pause |
| `F` | undo |
| `` ` `` | debug overlay |

During a wave the mouse throws balloons instead of placing parts — you are never
fumbling between two things on one button.

Walk into a near-vertical surface with rungs and you climb it. That is not a
ladder object — it is any structure the game recognises as climbable, which
means a ladder you nailed together yourself works exactly like one that shipped
with the game.

## What is here

```
src/
  core/        game loop, input, seeded RNG, math
  physics/     spatial hash, capsule-vs-OBB collision, part store, collision world
  player/      character controller, camera rig
  build/       part kit, snapping, build system
  render/      cel shading, procedural geometry, instanced meshes
  world/       backyard scene, starter structures
  game/        game modes, bots, flow-field navigation, projectiles
  audio/       synthesized sound
  app/         settings and persistence
  ui/          HUD
tools/
  shoot.mjs    headless screenshot + smoke-test harness
```

```bash
npm test         # 247 unit tests
npm run typecheck
node tools/shoot.mjs --out shots/x.png   # boot headless, screenshot, fail on any console error
```

## Design notes

**One module governs everything.** The grid step, the stair rise, and the ladder
rung pitch are all 0.25 m, and board thickness (0.05 m) divides it exactly. A
player stacking parts on the grid gets a climbable staircase without being told
what a climbable staircase is. Plank width is exactly one module, so four planks
laid side by side span a metre with nothing left over — the difference between a
floor that looks built and one that looks approximated.

**There is one broadphase.** Character collision, the build system's aim ray, and
snap-candidate lookup all go through the same spatial hash, so a board placed
this frame is immediately solid. A hash rather than a BVH because building spams
insert and remove, which a BVH would answer with a refit every time.

**Collision is custom, not a library.** The problem is one kinematic capsule
against static oriented boxes — no constraint solver, no joints, no CCD. The
closest point on the capsule spine is found by bisection on the derivative of
squared distance, which is exact here because distance to a convex set is convex
and the spine is affine. It is validated against a brute-force reference that
densely samples the spine.

**Flush boards are the hard case.** Two planks laid edge to edge form a
continuous floor, but the seam between them is an interior edge whose contact
normal points diagonally and shoves the player sideways as they cross it. Edge
contacts lying on a neighbouring face's plane get redirected onto that face
normal. There is a test that walks a capsule across a seam and asserts it holds
its line.

**Nothing is an asset.** Every shape is generated in code from a seed. The
cartoon look comes from chamfered edges — a visible bevel catches light
differently from the faces around it, and two or three pixels of it at play
distance is most of what separates this from programmer art.

**Bots route, they do not just steer.** Steering directly at the objective and
probing for gaps when blocked fails on exactly the structure this game is about:
in a U-shaped fort with the opening on the far side, a steering bot stops at the
near wall 4.35m out and never improves. So routing is a breadth-first flood from
the objective over a 0.75m grid, shared by every bot and rebuilt five times a
second; local steering only handles the last two metres. That matters beyond bots
looking stupid — the mode exists to show you where your fort failed, and if a gap
is never found, a leaky fort scores as a perfect one.

**Repeat the last step.** After two parts, the offset between them is almost
always what you want again — two rungs describe a ladder, two treads a
staircase. Hold `G` and it runs the chain, past where you could reach by aiming.
The delta is taken in world space, not the part's local frame: local stepping
compounds rotation, so any turn between two parts makes the chain spiral.

**Nothing is an audio file either.** Every sound is oscillators, filtered noise
and envelopes built at runtime. Beyond shipping zero bytes, it lets a footstep
shift pitch with surface and speed because it is being *built*, not played back.

**Multiplayer is not built, but it is not blocked.** Simulation runs on a fixed
timestep with no `Math.random` in anything affecting world state. Placement is
split into intent and application: `place()` returns a plain JSON-safe record
quantized to a millimetre, and `applyPlace()` is the only thing that mutates the
world. That is the seam a server would authorise against, and the same records
are the save format.

## Known limitations

**A ramp is hollow underneath.** The wedge collides as a thin slab lying along
its slope, so the walkable surface matches what is drawn — but the triangular
space beneath the slab is not solid. For a ramp on the ground that is
unreachable; for one placed in mid-air you can pass under it, which is arguably
the right behaviour for a thin ramp anyway.

**Snapping can show a red ghost with no valid alternative** when a long part is
aimed into a dense cluster — every candidate genuinely overlaps something. That
is accurate but reads as the game refusing without explaining. Worth an
auto-downgrade to a shorter part, or surfacing *why* it is blocked.

**Software-GL frame rate is not a signal.** The headless harness runs under
SwiftShader and reports single-digit FPS; that says nothing about real hardware.
Draw calls (~60 with scenery instanced, down from ~340) and triangle counts are
the numbers worth watching.

**Nav routing is 2D.** Bots walk on the ground toward a ground-level objective,
so the grid has one layer. A mode whose objective sits on top of a structure
would need a layered grid — one flood per standable height per column.

## Where this goes next

1. **Play Fort Defense and tune it.** Every number in it — build time, wave
   sizes, stash supplies, throw arc — is a first guess. This is the cheapest and
   most valuable next step, and it needs a human, not more code.
2. **Key rebinding and gamepad support.** The input layer already maps devices
   to named actions, so both are wiring rather than redesign.
3. **More construction tools**: blueprints, line-drag fill, an eyedropper, and
   moving a placed part instead of delete-and-replace.
4. **Netcode** — server-authoritative, client prediction, `PlacePart` intents
   replicated. The seams exist for this.
5. **More modes**, then woods survival, which wants resource gathering and
   structural support rules the sandbox deliberately does without.

The biggest risk is still not technical. It is that building under time pressure
is *stressful* rather than joyful — that players stop building and just run
around. Fort Defense makes that testable solo for the first time, but the version
that matters is two humans building against each other, and that needs netcode.
