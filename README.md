# Maker

A cel-shaded backyard building game. You get a pile of lumber and a lawn, and
you nail together whatever you want — ladders, staircases, towers, forts,
bridges. The long-term goal is party modes played *inside* the things you build:
capture the flag, water balloon battles, tag.

This repository is the first vertical slice: single-player, one backyard, and
the movement and building mechanics the whole game rests on.

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
| `F` | undo |
| `` ` `` | debug overlay |

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
  render/      cel shading, procedural geometry, instanced part renderer
  world/       backyard scene, starter structures
  ui/          HUD
tools/
  shoot.mjs    headless screenshot + smoke-test harness
```

```bash
npm test         # 148 unit tests
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

**Multiplayer is not built, but it is not blocked.** Simulation runs on a fixed
timestep with no `Math.random` in anything affecting world state. Placement is
split into intent and application: `place()` returns a plain JSON-safe record
quantized to a millimetre, and `applyPlace()` is the only thing that mutates the
world. That is the seam a server would authorise against, and the same records
are the save format.

## Known limitations

**The ramp collides as a box, not as a wedge.** `PART_KINDS[6]` renders as a
tapered prism but every part in the collision world is an oriented box, so you
walk into an invisible wall where the slope should be. Either give wedges a
collision proxy (a rotated thin box along the slope, which is what most games
do) or cut the part until that exists. Everything else in the kit is a true box,
so this is the only shape where visuals and collision disagree.

**Snapping can show a red ghost with no valid alternative** when a long part is
aimed into a dense cluster — every candidate genuinely overlaps something. That
is accurate but reads as the game refusing without explaining. Worth an
auto-downgrade to a shorter part, or surfacing *why* it is blocked.

**Software-GL frame rate is not a signal.** The headless harness runs under
SwiftShader and reports single-digit FPS; that says nothing about real hardware.
Draw calls (~300, mostly the individually-meshed fence) and triangle counts are
the numbers worth watching, and the fence should become instanced before the
yard grows.

## Where this goes next

1. **Netcode** — server-authoritative, client prediction for movement,
   `PlacePart`/`RemovePart` intents replicated. The seams above exist for this.
2. **First party mode.** Water balloon tag is the one to build first: it needs
   only projectiles and a hit rule, and it immediately answers the question the
   whole concept rests on — *is it fun to fight inside something you built?*
   Capture the flag is the better long-term mode but a worse first experiment,
   because it needs map balance to be fun and would confound the answer.
3. **More modes**, then the woods survival mode, which wants resource gathering
   and structural support rules that the sandbox deliberately does without.

The biggest risk is not technical. It is that building under time pressure is
*stressful* rather than joyful — that in a real match players stop building and
just run around. Testing that needs two humans and a timer, not more code, and
it should be tested before anything else is built on top.
