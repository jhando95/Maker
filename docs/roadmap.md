# Where this goes next

A review of the whole project at sixty-six commits, and a plan. Written after
the branch went green for the eighth time in a row, which is the right moment to
ask what is actually wrong with it rather than what is broken in it.

The short version: **the engineering is ahead of the game.** What exists is a
well-verified, well-instrumented, honestly-documented engine with five modes
bolted to it, and almost nothing that makes somebody open it twice. The next
phase is not more systems. It is robustness under conditions nobody has tested,
then retention, then reach on the platforms this game is actually for — which
are PC now, possibly console later, and never a phone.

---

## Part 1 — What is genuinely strong

Stated briefly, because the weaknesses are the point, and because a review that
opens with four pages of praise is not a review.

- **The verification habit.** ~158 bugs planted on purpose, every one written
  down, including the ones the tests failed to catch and why.
  [`docs/verification.md`](verification.md) is the most valuable file here and
  it is not close.
- **The measurement habit.** A GPU timer, a frame profiler, a leak soak, a
  benchmark, a boot-time shader warm-up. Most projects this age guess.
- **The seams.** `Command` → `MoveIntent` → `CharacterController.step` is the
  right decomposition, and it is why networking, replay and bots all reuse one
  path instead of three.
- **The world.** A cul-de-sac with a horizon on every side, evening, street
  lights, a lawn with a surface, structures that fall down when you take their
  legs out. It looks like somewhere.

---

## Part 2 — What is actually weak

Ranked by what it costs, not by how hard it is to fix.

### A. Every menu is mouse-only, and the controller stops at the door

**The platform decision is made: this is a PC game, possibly a console game
later, and never a phone game.** That is recorded here because the first version
of this document argued at length for touch input, and it was wrong to — the
reach argument is real for a game aiming at a phone audience and irrelevant to
one that is not. Touch is off the roadmap and is not coming back.

What the decision does *not* dispose of is the input gap underneath it, which
survives the change and gets more important because of it. There is a gamepad
layer (`src/core/gamepad.ts`, `gamepadManager.ts`, a scenario, bindings in
Settings) and it drives the *game* only. Every menu in this project — title,
mode select, pause, settings, locker, lobby, blueprints — is click-only. There is
no arrow-key navigation, no focus ring, no A-to-confirm, no B-to-back. Searching
`menu.ts` for `ArrowDown`, `focus()` or `tabIndex` finds nothing at all.

Two things follow. On PC it is a papercut with teeth: a player on a controller
has to put it down and find the mouse to change a setting, pick a mode, or hold
a blueprint. On console it is not a papercut, it is a wall — a console build is
not a port of the renderer, it is the entire UI learning to be driven by a stick
and two buttons, and every screen added between now and then is another screen
that has to learn it.

That is the argument for doing it early rather than at porting time: the cost is
proportional to how many screens exist, and screens are the thing this project
keeps adding. It is also the same work as keyboard navigation, and therefore the
same work as being usable without a mouse at all.

### B. The netcode has no failure story

The happy path is good: host-authoritative, 20Hz snapshots, prediction and
reconciliation, a loopback pair testing the whole thing in-process. What happens
when the network misbehaves is untested and mostly unwritten:

- **No reconnection.** A dropped socket mid-round is the end of that player's
  round. Phones sleep, wifi hiccups, tabs get backgrounded. This will happen to
  most real sessions.
- **No desync detection.** `StateHash` exists in `src/core/replay.ts` and is
  used only by the replay test. Nothing on the wire ever compares two worlds, so
  the first symptom of a divergence is a player standing on a wall nobody else
  can see, with no evidence of where it parted.
- **No host migration.** The host closing their laptop ends everybody's round.
  For a game about four friends, the person who happened to press Host is a
  single point of failure.
- **The protocol is JSON at 20Hz.** `encode`/`decode` in `protocol.ts` are
  `JSON.stringify`/`parse`. The file's own comment notes the shapes are flat
  tuples so a binary encoder could drop in. Nothing has measured what a full
  lobby actually costs per second, which is the number a bandwidth budget starts
  from.
- **The relay has no limits.** No rate limiting, no message size cap, no room
  cap, no auth — documented honestly as development-only, which is fine until
  somebody deploys it.

None of this is speculative hardening. Every item is a thing that happens on
ordinary home networks in an ordinary session.

### C. `main.ts` is 3,740 lines

It holds the renderer, the world, mode plumbing, comms, the lobby, multiplayer,
blueprints, input, the fixed update, the draw and the debug API. It is the one
file with no test beside it, and it is where the two worst self-inflicted bugs
of the last week lived (the funnel that called itself, and the debug hooks that
bypassed the funnel entirely).

`src/ui/menu.ts` (1,898) and `src/ui/hud.ts` (1,288) are the same shape and the
same untested. Thirty-five source files have no sibling test; most are small,
but `snapping.ts` (556), `bot.ts` (435), `lava.ts` (433) and `projectiles.ts`
(405) are not.

This is not a tidiness complaint. It is that the parts of the codebase with the
best verification story are the small pure modules, and the parts with none are
the big stateful ones where the bugs actually are.

### D. There is no reason to open it twice

A round starts, a round ends, a result screen offers Quit to Title. That is the
whole loop. There is no progression, no unlocks, no persistence of anything a
player did except their own saved builds, no reason for the fifth session to
differ from the first.

Related and worse: **a blueprint cannot leave the machine that made it.**
`BlueprintStore` is localStorage with no export, no import, no share code. The
genre's clearest lesson — the thing the research kept returning to — is that
the pipeline from *player* to *creator* is what makes these games last. This
project has the building depth and none of the sharing.

---

## Part 3 — What the genre knows

Concrete things worth taking, and from where.

**Roblox / Fortnite Creative — the creator pipeline.** The wall between playing
and building is the thing to remove. (Taken for the pipeline only. The platform
lesson usually drawn from Roblox is a mobile one, and this project has decided
against that.) Here that means: a blueprint gets a share
code, a code can be pasted, and a yard remembers what was stamped in it. That is
a small feature with an outsized effect, because it turns every player into a
supplier of content for every other player.

**Fall Guys / Stumble Guys — the round is the unit, not the session.** Short
rounds, instant re-queue, no lobby to walk back to. The result screen here
should offer *Again* and *Next mode* before it offers Quit, and a party should
survive a round ending rather than dissolving to the title.

**Gang Beasts / Human Fall Flat / Party Animals — comedy is a physics budget.**
The consistent finding is that the funniest moments are the ones the designer
did not author: floppy bodies that respond to intention but not precisely. This
project has capsule characters with perfect control and a structural model that
is binary — a thing stands or it falls. The nearest cheap win is not full
ragdoll; it is **collapse that is watchable**: parts that tumble for a second
before they vanish, a kid who gets knocked off their feet and has to get up.

**Minecraft / Teardown — destruction is the reward.** A collapse currently
removes parts. Making it *look* like a collapse — with the clatter that already
exists on the wire — is most of the payoff of the support system this branch
spent a fortnight on.

**Besiege / Poly Bridge — show the model.** Both make a structural simulation
legible: you see where the load is. The support system here knows which parts
are anchored and through what chain, and shows the player a boolean. A "what is
holding this up" view is nearly free and turns an invisible rule into a toy.

**Among Us / Rec Room — social features are retention features.** Proximity
voice already exists here, which is the expensive half. The cheap half missing
is a roster: a list of who is in the round, with a mute button next to each
name. The mute rule and its storage are already written; there is nowhere to
click.

---

## Part 4 — Modeling, in the three senses that matter here

### 1. Modelling the *system*, to make it robust

This project verifies by planting bugs, which is excellent and is a technique
with a ceiling: it checks the cases somebody thought of. The next tier is
techniques that generate cases nobody thought of.

- **Property-based testing.** Two files already hand-roll a seeded sweep
  (`capsuleObb.test.ts`, `session.test.ts`); a real generator library would
  shrink failures to a minimal case instead of printing the seed. Properties
  this codebase is full of and does not state: a blueprint stamped and captured
  round-trips; four quarter turns are identity (asserted for one blueprint,
  should hold for all); `collapseAfter` never returns an anchored part; a
  snapshot encoded and decoded equals itself; wetness is monotonic under water
  and only under water.
- **Deterministic simulation testing.** `replay.ts` is already the hard half of
  this. The missing half is a *simulated network*: a transport that injects
  latency, jitter, loss, reorder and duplication under a seed, so a failing
  session is replayable. This is the technique that finds the reconnection and
  desync bugs in Part 2B before a player does, and it is the highest-value item
  in this whole document per hour spent.
- **Invariants checked continuously, not at assertion sites.** A debug mode that
  asserts every tick — no part unsupported and still drawn, no actor outside
  bounds, no negative lumber, no duplicate actor id — turns the existing soak
  and every scenario into a fuzzer for free.
- **A state machine for the session.** Joining, playing, dropped, rejoining and
  ending are currently implicit across `session.ts` and `main.ts`. Writing the
  machine down makes "what happens if a guest's socket dies during a round
  change" a question with an answer rather than a thing to find out.

### 2. Modelling the *world*, to make it richer

- **Structure as load, not just connectivity.** The current model is: touching
  counts, a chain to an anchor stands. It is the right first model and it is
  documented as such. The next one is a cheap load model — each part has a
  capacity, each joint carries a share, and a span that is too long sags and
  then fails. This is what makes a bridge over the pool a decision instead of a
  formality, and it is the single change that would make building *interesting*
  rather than merely *possible*.
- **Ragdoll on the way down.** Not a full physics character — a two-second
  ragdoll on collapse and on being knocked over, then back to the controller.
  This is where the comedy in this genre lives.

### 3. Modelling the *art*, to make it look made

Everything is procedural boxes and instanced meshes, which is why there is no
asset pipeline and no texture at all. That has been the right trade and it has
two visible costs: characters cannot be animated beyond what a transform per box
allows, and paint is marks rather than a canvas.

- **Skinned meshes for the kids** would allow real animation blending — a walk
  that leans into a turn, a throw that follows through. Expensive, and the honest
  note is that it trades away the thing that makes the current cast cheap.
- **A texture atlas** is the smaller and better-value one: one 512×512 sheet
  unlocks wood grain, faces with expression, and paint as a bitmap, at a cost of
  one texture bind. The record format for a tag already has room for a bitmap.

---

## Part 5 — The plan, in order

Ordered so that each step is worth doing even if the next never happens.

**1. A simulated network, and the bugs it finds.** A `Transport` that injects
latency, jitter, loss and reorder from a seed; then reconnection, then a state
hash on the wire that says *when* two worlds parted. Highest value per hour in
the document, and it is testing infrastructure, so it pays out on everything
after it.

**2. Menu navigation by stick and by key.** A focus model shared by every
screen, arrow keys and the left stick to move through it, A to confirm and B to
back out, a visible focus ring in the existing design language. Do it now rather
than at porting time, because the cost scales with the number of screens and
this project keeps adding screens.

**3. Break up `main.ts`.** Not a rewrite — extract the four cohesive lumps that
are already visually delimited by its own section comments (comms plumbing, the
lobby, blueprints, the debug API) into modules with tests. Do it *after* step 1
so there is a network harness to catch what moves.

**4. The round loop.** *Again* and *Next mode* on the result screen, a party
that survives a round, a roster with mute buttons on it. Small, and it is the
difference between one round and an evening.

**5. Share codes for blueprints.** Export, import, and a yard that remembers.
The creator pipeline, at the smallest scale that still works.

**6. Watchable collapse.** Tumble the parts on the way down, knock the kid over,
and let the clatter that is already on the wire land on something visible.

**7. Load-bearing structures.** The model upgrade from connectivity to capacity.
Do this last of the seven because it changes the feel of every existing build,
and it wants the invariant checking from step 1 behind it.

**Then the decisions**, which are not engineering problems and should be taken
deliberately rather than drifted into: whether voice gets a TURN server, whether
the locker becomes progression, whether Tag escalates to many Its.

---

## Part 7 — Frames and latency, measured rather than assumed

Added after a second pass aimed specifically at frame rate, latency, lighting and
infrastructure. Ordered by measured value, and where a number is a guess it says
so.

### The finding: what players build is never culled

`partRenderer.ts` sets `frustumCulled = false` on every part mesh and on every
outline shell, with a comment explaining why: an `InstancedMesh`'s bounding
sphere is computed around its origin, and the instances are scattered across the
whole yard, so three.js would pop an entire fort out of view the moment that
origin left the frustum. The comment is correct. The consequence is that **every
plank anybody has ever placed is submitted every frame, twice** — once for the
mesh and once for the inverted-hull outline — regardless of where the camera is
pointing.

Measured on the software rasteriser CI uses: turning away from a 129-plank
structure saves 172 draw calls and 55,000 triangles, and **none of that saving is
the structure**. It is the scenery, which is properly culled by `propBatch`. The
fort is drawn either way.

This is the one cost in the game that a player controls without limit. A fort of
three thousand parts is roughly a quarter of a million triangles submitted per
frame from behind a wall you cannot see through.

**The fix is chunking, not per-frame packing.** Repacking the instance buffer
each frame to hold only what is visible means uploading the whole buffer sixty
times a second, which trades a rasterisation cost for a bandwidth one. One
`InstancedMesh` per *(kind, spatial chunk)* gives three.js a bounding sphere it
can actually use, costs nothing per frame, and needs no upload at all — draw
calls rise with the number of visible chunks and fall with everything else. It is
a real refactor of a 400-line file with two invariants in it (swap-with-last, and
the outline sharing the parent's matrix buffer), which is why it is written down
here rather than done in passing.

### Latency, which nothing has measured

Every performance number on this project is a throughput number. Nobody has
measured the delay between a key going down and the pixel changing, and there are
three places it hides:

- **The canvas is composited.** A WebGL context created with
  `desynchronized: true` opts out of the compositor's own frame queue, and is
  worth one whole frame on a machine that is keeping up. It is one flag and a
  measurement, and it is the cheapest latency win available.
- **Input is folded at a tick boundary**, and the tick can be up to 16ms before
  the frame that shows it. Sampling the pending buffer as late as possible in the
  frame, rather than at the top of it, is free.
- **Nothing measures any of this.** The honest first step is a scenario that
  drives a key and counts frames to the first pixel change, so the two changes
  above can be shown to have done something rather than asserted to have.

### Lighting: ambient occlusion from a graph that already exists

The renderer is a toon ramp, an inverted-hull outline and a static shadow map,
and it has no ambient occlusion — so the inside of a fort is exactly as bright as
the lawn, and a box stacked on a box has no seam.

The usual objection is cost: AO means either a screen-space pass or a bake, and
this project has no texture pipeline to bake into. But it does have something
better and unusual — **`support.ts` already computes, on every placement and
removal, which parts touch which**. That joint graph is an occlusion estimate: a
part with six neighbours is in a corner, a part with one is in the open. Feeding
a per-instance darkening factor from the neighbour count into `instanceColor` —
which every part mesh already carries, and which is already uploaded when a part
is placed — gives a fort that gets darker where it is enclosed, for the cost of a
byte per part and no new pass at all.

That is worth doing because it is unique to this game rather than borrowed: the
structural model was built to answer whether a tower falls down, and it turns out
to answer where the light does not reach.

### Smart UI, beyond the map

The map is in. The two things next to it that are cheap and change how a round
reads: **contextual density** — the HUD currently shows the same panels whether
you are building or fighting, and a mode already declares which meters it has —
and a **roster**, which is also the missing home for the per-player mute that
exists in code and in Settings with nowhere to click.

### Infrastructure

- **CI is thirty minutes and serial.** Twenty-seven scenarios run one after
  another in one job. They are independent processes with independent dev
  servers, so a matrix of four or five shards is a mechanical change to one
  workflow file and takes the wall clock to about eight minutes. This is the
  highest-value infrastructure change available and it is nearly free.
- **The bundle is one 925KB chunk**, 258KB gzipped, with no code splitting. The
  menus, the locker and the lobby are not needed to draw the first frame.
- **Nothing guards against a performance regression.** The benchmark runs in CI
  and its numbers are read by a human or not at all. A recorded baseline with a
  tolerance would make a slow commit fail rather than be noticed a month later.

### Order

1. **Shard CI.** Nearly free, and it shortens every loop after it.
2. **Measure latency**, then `desynchronized` and late input sampling.
3. **Structural AO**, which is small, unique, and needs no new pass.
4. **Chunk the part renderer.** The largest win and the largest risk; do it once
   there is a latency and throughput measurement to show it did not cost
   anything elsewhere.
5. **A performance baseline in CI**, once there is something worth protecting.

---

## Part 6 — What I would not do

- **Not a fourth and fifth mode.** Five exist. The marginal mode is worth less
  than making one round lead to another.
- **Not skinned characters yet.** It trades the cast's cheapness for animation
  quality, and animation quality is not what is missing.
- **Not server-authoritative simulation.** Host-authoritative with a real
  reconnection story is the correct amount of netcode for a game four friends
  play, and moving the simulation to a server is a deploy target and an
  operating cost this project has correctly declined three times.
- **Not a rewrite of anything.** Every problem in Part 2 is additive.
