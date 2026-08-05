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

Every binding above is remappable in Settings → Controls.

### Controller

Any standard-mapping pad works, and is picked up the moment you touch it — the
on-screen hints switch to match. Look speed and stick deadzone are in Settings.

| | |
|---|---|
| Left stick | move — push it partway to walk |
| Right stick | look |
| `A` / `B` | jump / crouch |
| `L3` | sprint |
| `RT` / `X` | place / remove |
| `LT` | free aim |
| `LB` / `RB` | turn the held part 15° |
| `D↑` / `D↓` | tilt / roll |
| `Back` | reset rotation |
| `Y` | cycle to the next snap candidate |
| `D←` / `D→` | choose a part |
| `R3` | first ⇄ third person |
| `Start` | pause |

Rotation gets the bumpers because it is the most-used building control and the
bumpers are the only buttons you can reach without letting go of a stick.

Undo, repeat-place and the hotbar digits stay on the keyboard: there are more
bindable actions than a pad has buttons, and a chorded second layer would be
harder to learn than reaching over for the two things you rarely need mid-build.
The pad layout is fixed rather than remappable.

One browser limitation, not a design choice: entering the game needs a real
click, because pointer lock cannot be granted from a controller button. After
that, `Start` pauses and resumes without touching the mouse.

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
  app/         settings, persistence, crash handling
  ui/          HUD
tools/
  shoot.mjs    headless screenshot + smoke-test harness
  bench.ts     simulation cost per tick, at 3000 parts
scenarios/     scripted checks driven through the harness
```

```bash
npm test         # 310 unit tests
npm run typecheck
npm run bench    # what a tick costs, as a share of the 16.67ms budget
node tools/shoot.mjs --out shots/x.png   # boot headless, screenshot, fail on any console error
node tools/shoot.mjs --scenario scenarios/gamepad.mjs   # drive a synthetic controller
```

CI runs all of the above on every push. The scenarios exist because some things
cannot be honestly unit-tested: whether a throw inside the render loop actually
produces a crash screen, whether a stick push actually reaches the character
controller, whether a resolution decision actually reaches the drawing buffer.
All three only happen in a browser, so all three are checked in one.

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

**Ammo comes from outside the fort.** Refilling at the stash rewarded standing
on the objective — a turret sit, with the fort as scenery you happened to be
inside. Three buckets sit 9.5m out, past where a fort usually ends up, and
filling up is a short channel rather than a pickup. That turns the round into a
traversal loop *through* your own walls: you have to leave, get back in, and
find out whether the way you built it is a route or an obstacle. Which is the
mode's whole question, asked every thirty seconds instead of once.

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

The chain is drawn before you run it, fading along the way. The projection uses
the same rules the chain itself does, including the overlap test — and each
projected link is treated as solid so the ones behind it see it, or a step
shorter than the part would preview ten treads where only the first can exist.
That is the whole value: a run that would stop at a wall visibly stops there,
rather than being something you find out about after committing to it.

**Nothing is an audio file either.** Every sound is oscillators, filtered noise
and envelopes built at runtime. Beyond shipping zero bytes, it lets a footstep
shift pitch with surface and speed because it is being *built*, not played back.

**The game gives up resolution before it gives up frame rate.** Simulation cost
is measured and bounded — `npm run bench` reports it per tick, and the heaviest
line is a few percent of the budget at three thousand parts. GPU cost is not
knowable here, so render scale adapts: two bad seconds steps it down, and
stepping back up is refused unless the frames being measured *now* would still
fit the budget with the extra pixels. That prediction is the load-bearing part.
Waiting longer to recover than to degrade sounds sufficient and is not, because
the measurement changes when the scale does: a machine slow at 100% and
comfortable at 90% would be judged comfortable, restored, found slow, dropped,
and around forever — every decision right, the result unusable. Shadows and
outlines are never touched; they are how the game looks, and that is the
player's call.

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

1. **Play Fort Defense and tune it.** In particular the bucket loop: 9.5m and a
   0.6s channel are guesses, and the whole balance of turtling versus running
   turns on them. Every other number — build time, wave sizes, stash supplies,
   throw arc — is a first guess too. It needs a human, not more code.
2. **Gamepad support.** The input layer already maps devices to named actions
   and rebinding is in, so this is wiring rather than redesign.
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
