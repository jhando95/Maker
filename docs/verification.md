# What the tests could not see

A running record of the checks on this project that **passed for the wrong
reason**, and of the red builds that turned out to be the check's fault rather
than the game's.

It is kept because a test that cannot fail is worse than none, and because the
only way that stays true is if the ones caught doing it are written down where
the next person will read them. Every entry here was found the same way: by
planting the bug the assertion forbids and watching it pass anyway.

The pull request that introduced most of it links here rather than carrying it,
which is also why it is in the repository — a description is a moment, and this
is a habit.

## The ones that did *not* fail, and what happened to them

- **"It cannot thaw"** was enforced twice over — It has no runner record, so the
  line that says so could be deleted without any test noticing. The two
  conditions were rewritten so each rule has exactly one guard.
- **A slide's ghosting** compared a measured surface against the number it
  equals, which is true either way by a float's width. It reads the slab list the
  flow field reads now, which also covers the likelier future mistake: something
  *else* solid parked on the lane.
- **Two mantle tests** measured where the player wandered to two seconds after
  the pull-up rather than the pull-up; a third could not reach the rule it named,
  because the step-up carries a player over a low ledge before jump is pressed.
- **The grass-through-paving check** is invisible from directly overhead — the
  blades are edge-on. Moved to `scene.test.ts`, checked against the street's
  footprint. It broke again during the performance pass: it read a single named
  mesh, and once chunking made that name a `Group` it silently measured nothing
  — *and its neighbour went green having found no grass anywhere to be on the
  road*. It traverses the group now.
- **"The lawn is many colours"** passes on a perfectly flat lawn, because ten
  thousand individually tinted clumps supply hundreds of colours by themselves.
- **The worn-ground check** was standing on the flag base's red plinth, so the
  "bare ground" being measured was paint.
- **A character-batch test** asserted that unused slots keep parked matrices "so
  instance counts never churn", which is not a thing — `count` is a number handed
  to the draw call, and the whole point of the change was to lower it. It asserts
  `count === 0` now.
- **The build-bounds tests** were being refused by the barrier's own collision
  rather than by the rule under test. They run in a barrier-free world now.
- Two frame-parser tests rested on claims that were not true: one on unmasking
  being able to corrupt an unread frame, and one on a `length > MAX_FRAME` branch
  that is unreachable while the cap exceeds 65535.
- **The collapse scenario's "taking the top off" control took the top and one
  more.** `demolishNear` picked a part within 5cm of the point rather than the
  part containing it, so aiming at a panel resting on a post got the post — and
  reported the collapse of a whole tower as the removal of its top. The probe
  is a containment test now, with the lowest id winning a tie so two parts
  sharing a point cannot make the answer depend on the order a spatial hash
  walks its cells.
- **"The map is not a bot's to demolish" was proving a rule it never reached.**
  The test put no wall round the stash at all, so the kids walked to it happily
  and never reached for anything — it passed with the fixture guard deleted. It
  seals the stash with *map geometry* now, so the kids are as thwarted as in the
  test above and have been at it just as long. Worth adding that the outcome is
  guaranteed twice over: `demolish` refuses fixtures outright and is the
  authority, and the check in the bot exists so a kid does not spend two and a
  half seconds hauling on a fence for the rest of the round.
- **`git checkout` on a file that was also carrying uncommitted work.** Not a
  test that could not fail — a plant that took the feature with it. Every other
  plant today copied the file aside and copied it back; this one reverted
  `src/main.ts` to `HEAD` to undo the plant and silently deleted the profiler
  wiring in the same stroke, which `tsc` then reported as *no errors* because a
  file with none of the code in it compiles perfectly. Copy aside, never check
  out.
- **Three checks in a row about the build preview, all passing on a preview
  that was not there.** The collapse scenario asks whether the ghost warns you
  that a placement will not hold, and it ran behind the title menu — which
  pauses the loop, so `build.update` never ran, so there was no candidate, so
  "would this hold" answered *yes, nothing is wrong* every time. The stamping
  and demolishing either side of it go through debug hooks and work paused,
  which is exactly why it was invisible. `buildPreview()` now reports whether
  there **is** a preview and **where** it landed, and the scenario asserts both
  before asking anything about support: without the position, a ray that sails
  under a plank three metres up and hits the lawn answers the question about
  the wrong placement. Two more of the same family on the way in — aiming
  before the teleported body had finished falling, so the ray was computed from
  an eye 60cm above the one that fired it; and reading the preview in the same
  `evaluate` that moved the camera, before a frame had run.
- **The back-door light check was asserting on somebody else's house.** Written
  as "a light behind the house at door height" and nothing else, it passed with
  the back-door light deleted: a neighbour's front window forty-two metres east
  sits at z 7.2, which is inside "behind the house" if you never say how far
  behind. Both house-light checks are bounded in x as well as z now, off the
  `HOUSE` constants rather than off numbers.
- **The blueprint scenario's all-or-nothing check depended on where a crosshair
  landed.** It called `stamp()` twice and hoped the second aim still collided
  with the first, which is not a thing the scenario controlled — the moment the
  staircase exists the ray lands on *it*. Measured, the anchor moves from y 0.15
  to y 1.125 the instant a single frame runs between the two calls, and the
  parts in the way fall from thirty to twelve: still refused, but by a margin
  that was never the claim, and a slower runner eventually spent it. The second
  attempt replays the first one's exact records now.

## CI failures that were product bugs, not flaky tests

The handshake race above. `wheel.mjs` waiting **250ms of wall clock** — plenty of
frames with a GPU, *one* frame through SwiftShader, and input is folded at a tick
boundary, so it read state from before the key was pressed. The balance tests
timing out once the drain check added a raycast per kid per tick. And a TDZ crash
at boot, caught by the smoke test, because `settings.subscribe` fires immediately
and read a `const` declared below it.

Same root cause as every scenario failure on this project so far: **a test
asserting on state it had not established.** The comms scenario made it again on
the way in, reading `innerHTML` in the same turn as the `say` that writes it.

**And one wrong diagnosis of my own, corrected in the file that carries it.** Jobs
were cancelled at exactly 15m 1s having never been assigned a machine, and I
blamed `timeout-minutes`. I raised it from 15 to 30 and the next run was
cancelled at 15m 1s again, still unassigned: the fifteen minutes belongs to the
platform and nothing in the workflow changes it. The comment in `ci.yml` says so,
because the wrong answer is convincing.

## Red checks that were not product bugs

Worth naming together, because the pattern is more useful than any one of them
and because a red check deserves an account rather than a shrug.

- **The crash scenario waited 500ms for a thing that takes one frame.** Measured:
  8ms warm, 236ms cold, and most of a second through SwiftShader — it had been
  landing the right way rather than being correct. All three waits are conditions.
- **The voice scenario asked a noise suppressor to pass a synthetic beep.** The
  call was healthy — 13,370 packets, gain 1, cutoff open — and the far end read
  **0.0151 against a `SPEAK_ON` of 0.018**, because `getUserMedia` is asked for
  `noiseSuppression` and Chromium's fake microphone is a tone. Lowering the
  threshold to suit a fixture would flicker the indicator on room noise for
  every real player, so the chain is three separately-honest checks instead.
- **Two sampling races of my own, chasing the second one**, and a fourth later:
  the kids scenario waited three frames for a camera blend that is eased, so
  "in first person" was a bet on frame time and the local player was still being
  drawn.

- **And then it was the scale settling, and the crop that should have been
  there from the start.** With the ghost hidden the check finally failed on its
  *margin* rather than on a precondition — 16,776 lit pixels against 4,812
  moving on their own, needing four times that. Two things were wrong. Turning
  adaptive quality off *restores* the scale it had been throttling, which
  resizes the buffer the whole picture is drawn into: the assertion that the
  scale had held ran after the measurement, checking the wrong end of a move
  that happens at the start. It waits for two consecutive readings to agree
  before shooting now. And the comparison measured the whole frame for a claim
  about lamps — it is cropped to the band the lamps and the lit windows are in,
  which leaves out the near fence and lawn, the part of that shot that is never
  quite still. A crop *toward* the claim rather than away from it: a check about
  lamps has no business measuring grass.
- **And then it was the build ghost, and the real mistake was the shape of the
  check.** Pinning the render scale did not fix it either; the third failure
  printed the sequence — `3232, 2610, 8548, 2485, 2721, 2334, 8649, …` — which
  bounces rather than trending down, and the thing bouncing was the placement
  preview, easing toward wherever the aim ray lands, a hand's width under the
  lamp the shot was framed on. It is hidden for the measurement now, which is
  also just correct: a photograph of a light should not have an aiming preview
  in it. But the lesson is not "find the third mover". Twice a working feature
  was reported broken because a *precondition* of the measurement failed, so the
  precondition is gone: the picture is no longer asked to hold still, it is
  asked how much it is moving, and the glow has to beat that number four times
  over. That is the claim that was wanted all along, and the only one that
  cannot be defeated by finding a fourth thing that moves.
- **The settle loop then never settled, because the renderer was resizing under
  it.** Adaptive quality changes the size of the buffer the whole picture is
  drawn into, so while the governor is hunting, *every* pixel is a changed
  pixel. On a machine that keeps up it lands on 1.00 and is never noticed; at
  seven frames a second on CI it never stopped moving and the loop ran out of
  tries. The scale is pinned across the measurement now, and checked afterwards
  to have held — two shots drawn at different resolutions differ everywhere, and
  the difference would have been read as light. The loop also reports the whole
  sequence it saw when it gives up: a run that trends downward was given too
  little time and one that bounces has something in it that will never stop,
  and those want opposite fixes.
- **A 400ms wait standing in for "the picture has stopped moving".** The lamp
  check differences two screenshots, so it first has to establish that nothing
  else in the frame is moving — and it established that by waiting. Four hundred
  milliseconds is thirty frames on a real card and *three* through SwiftShader,
  and the placement ghost eases toward wherever the aim ray lands, so the guard
  passed here and reported 8,940 moving pixels on CI. It shoots until two
  consecutive frames agree now. The guard caught exactly what it was written to
  catch; it was the guard's own precondition that was a bet.
- **The lamps rendered nothing, and everything said they were on.** The shader
  compiled, the level was 1, the instance count was thirty, and not one pixel
  changed. `InstancedMesh.computeBoundingSphere` walks `count`, and the bound was
  computed at build time while the lamps were off — so three culled the mesh
  against a bound around nothing, every frame, forever. Nothing in the object's
  own state was wrong; only the picture was. It is the reason the check that
  found it photographs the glow **on its own** — same time of day, same sky, same
  fog, same shadows, lamps the only thing moved — rather than differencing dusk
  against noon, where a few thousand pixels of lamp are lost among half a million
  pixels of sky. And it is why that check measures the frame's own restlessness
  first and requires the signal to beat it: the first version of it read a camera
  still easing into place as a glow, symmetrically, five thousand pixels up and
  five thousand down.

Every one of those is the same mistake in a new costume: **asserting on state
that had not been established** — a frame budget standing in for the game's own
clock. The honest read is that `scenarios/voice.mjs` is the most expensive check
here and has been the least trustworthy; it earns its place because nothing else
can prove one browser can hear another.

## What the profiler said the first time it was asked

Worth recording because it is the answer nobody would have guessed, and because
it is the reason `frameProfile.ts` always reports the part nobody instrumented.

On the first run, in an empty yard, the breakdown came back **`rest` 190ms
(88%), `draw` 24ms (11%), `sim` 0.9ms, `ui` 0.2ms, `anim` 0.08ms, `net`
0.01ms** — and in Tag with six kids on the street, `rest` **97%**. Almost the
entire frame is outside every section this project instruments, because the
harness rasterises in software on a shared runner and the time goes to the
compositor.

Two things follow. The first is that the leftover had to be reported: without
it the readout would have said "draw is the biggest thing at 11%" with total
confidence and never mentioned the 88%. The second is a caution about every
performance number this repository has ever taken from CI — **the harness is
bound by something that is not our code**, so a frame time measured there is a
property of GitHub's fleet. The scenario asserts structure, not milliseconds,
for exactly that reason.

## When I misread a screenshot and the measurement said otherwise

The prop-merging change rewrites how every static object in the world is turned
into geometry — matrices baked in, colours moved from a per-instance attribute
to a per-vertex one, indexed boxes expanded to triangle lists. Exactly the class
of change that goes subtly wrong.

I took a screenshot, looked at it, and concluded it *had* gone wrong: a dark
polygon across one corner, odd shapes along the bottom edge. Then I shot the
same frame with the change stashed and diffed them: **0 of 921,600 pixels
differ**. The shapes I was suspicious of are what that corner of the yard looks
like. Nothing was wrong.

Worth writing down as the mirror of everything else in this file. The habit here
is planting bugs because a test that passes proves little; this is the same
habit pointed at me — an eye that says "that looks broken" proves nothing
either, and the two-minute check that settles it is a baseline and a diff.

## When the measurement changed the design

Not a failure, but the same discipline pointing the other way, and worth one
entry. Bots were given demolition by hanging it off the state they already
reach when every diversion is blocked — a kid pressed against a wall with no
way round. The reasoning was good and the measurement disagreed: against a real
ring wall that branch fired **zero times in sixty seconds**, because the
diversion probes reach two radians either side and from outside a round fort
those always find open lawn. The kid circles it forever, perfectly content.

So the trigger became *cannot get closer* rather than *cannot move*, which is
what "the fort is working" actually means — circling a wall holds the distance
to what is inside it exactly constant, and a way in reduces it. An open fort is
still beaten by walking through the gap, and there is now a test that says so.

## What the GPU said about the 88%

`FrameProfile` landed with the leftover at 88% of a frame in an empty yard and
97% in Tag, and the honest reading at the time was "almost the whole frame is
outside everything this project instruments". It could not be narrower than
that, because a stopwatch on the main thread cannot see past the main thread.

A timer query can, and it turns out `EXT_disjoint_timer_query_webgl2` *is*
present under SwiftShader — the one machine nobody expected it on. Measured in
an empty yard: the CPU spends **28.7ms submitting** draw calls and the driver
reports **374ms of GPU time**, against a frame of about 250ms.

More GPU milliseconds than the frame has is not a contradiction, and it is worth
writing down because the number would otherwise look like a bug in the timer.
SwiftShader rasterises across several worker threads and `TIME_ELAPSED` sums
them, so 374 is thread-milliseconds rather than wall clock. The reading that
settles it is `latency`, stable at 4 frames in all three scenes: a renderer
genuinely 374ms behind a 250ms frame would fall further behind every frame and
the queue would grow without bound.

So the leftover is rasterisation, and there is a number for it now rather than
an inference. It also confirms, rather than merely suspects, that every
performance figure this repository has taken from CI is a figure about a
software rasteriser.

A lesson worth keeping separately: four of those five probes asked "which object
is missing?" and the answer was "none". The question that worked asked what
changed about the objects that were already there. When a hypothesis fails
twice, the next move is to change the question rather than to sharpen the
instrument.

## The soak, and the two plants it took to make it mean anything

`scenarios/soak.mjs` runs twenty-four identical rounds of building, painting,
demolishing, nightfall and a mode change, and asks whether the renderer is
holding anything afterwards. It passes, and the first two attempts to prove it
could fail are the interesting part.

**The first plant survived.** Removing `bucket.mesh.geometry.dispose()` from
`PartRenderer` changed nothing, because that line is inside `dispose()` — the
whole-renderer teardown, which a session never calls. The soak had never been
near it. That is the entire argument for planting: the test looked like it
covered the build path and did not.

**The second plant survived too.** `TagDecals.dispose()` and
`NightLights.dispose()` are the same shape — teardown-only. Following that
thread is what turned up why nothing leaks here, which is a design fact rather
than luck: **every render batch in this project allocates at construction and
mutates counts afterwards.** A round never builds a mesh. It is the same rule
that makes `count` the way things are hidden, arrived at for a different reason.

**The third plant caught it**, and it is the regression that design exists to
prevent: `TagDecals.set` rebuilding a geometry per change instead of writing
counts, which is exactly what a tidying refactor would produce. Geometries went
174 → 223 → 267, which the log reports as "+49 then +44 over 12 identical cycles
each".

That number is also the argument for the two-halves shape. Real growth over the
first twelve cycles is +5 — modes and tag shapes being drawn for the first time,
since `info.memory.geometries` counts an upload rather than a construction — and
a threshold loose enough to allow it is a threshold that would have allowed a
small leak forever. A cache flattens; a leak keeps its slope. So the assertion
is that the *second* half grows by nothing at all, and the first half exists
only to give the caches somewhere to go.

## The warm-up, three wrong hypotheses and one bad plant

`renderer.compile` before the loop starts, so the driver compiles every shader
on the title screen instead of the first time a flag appears. The measured
effect is real: geometries uploaded at boot go **174 to 204**, the soak's
first-half geometry growth goes from +5 to **flat**, and the program compiled on
the first spray is gone. Getting there took four browser probes and most of them
were wrong, which is the part worth keeping.

**Right:** `compile` walks the scene the way a render does and never descends
into `visible === false` — and hidden is the state of every flag, crate,
balloon, lamp glow and tag shape in this game, all built at boot. Handed the
scene as it stands it warms the lawn and the fence, reports success, and leaves
every hitch exactly where it was. Forcing visibility found **70 hidden
objects**.

**Right, and only found by measuring:** that still left one program compiling
when Tag started, and its cache key begins `depth` — a *shadow* program.
`compile` warms the pass that draws to the screen; a shadow map is a second pass
with its own material per caster, and the only way to compile a pass is to run
it. So the warm-up now renders one frame with everything visible, and
invalidates the shadow map on the way out because the map it just drew contains
a shadow for every hidden object in the world.

**Wrong, and kept anyway:** the next guess was that instanced meshes at `count`
zero are skipped like hidden ones, so the whole cast was going uncompiled. The
first half of that is true — it is the rule this project has written up twice
already — and lifting the counts is now part of the warm-up and tested. It
changed no number here, because those programs were already compiled by meshes
sharing a key. It is in because it is correct, not because it fixed anything.

**And then found, on the fifth probe, by asking a different question.** One
`depth` program was still compiled when Tag first ran, and four probes had gone
looking for an object the warm-up had missed. There wasn't one. The warm-up
reaches everything; the mistake was assuming a program is determined by *which*
objects are drawn.

`setColorAt` creates `instanceColor` the first time it is called, and **the
presence of that buffer is part of a shader's identity** — a mesh with one
compiles `USE_INSTANCING_COLOR`, in the shadow pass as much as the colour pass.
On a title screen nobody has been coloured yet, so every character mesh still
had `instanceColor === null`; the warm-up faithfully compiled the
no-instance-colour variant of each, and the first kid posed needed the other
one. Nothing was missing. An object was in a different *shape* than it would
later be.

The probe that found it took thirty seconds to write and should have been the
first: rather than diffing shader cache keys, walk every mesh in the scene
before and after and diff the properties that *feed* a cache key — instancing,
instance colour, morphs, side, alpha test, vertex colours. Twenty-odd meshes
came back `icolor: false -> true`, all of them the cast.

`giveInstanceColor` allocates the buffer at construction, filled with white so
an instance nobody has coloured draws exactly as it did. Programs across
twenty-four rounds now go **18 → 18 → 18**, and the total is one *lower* than
before, because unifying the state removed a variant rather than adding one.
The soak asserts zero now instead of a ratchet at one.

**And a plant that missed for its own reasons.** Nine were planted on the
warm-up and eight failed immediately. The ninth — leaving the shadow map
standing — passed twice, and both causes were mine rather than the test's.
First the fake renderer never cleared `needsUpdate` the way three does after
drawing a map, so the flag was left true by the *earlier* assignment and the
assertion could not fail. Then, with that fixed, the plant itself was wrong: it
inserted a dead line and left the real assignment further down untouched. Once
the plant actually removed the assignment it failed at once. A plant that
survives is a claim about the test *or* about the plant, and it is worth knowing
which before rewriting either.

## And a red check that was mine, in the file that warns against it

`scenarios/profile.mjs` opens by saying it asserts structure rather than
milliseconds, because this harness runs through SwiftShader on a shared runner
and a budget here would be a claim about GitHub's fleet. Then the GPU-timer
assertions went in with `latency > 0 && latency < 30` — "a GPU reading should be
a few frames late" — which is a claim about GitHub's fleet.

CI failed at exactly thirty: `gpu 282.97ms over 26, 30 frames late, 93 skipped,
0 binned`. Nothing was wrong. On a runner rasterising in software the driver
really is that far behind, and 93 of 120 frames going unmeasured is the fixed
pool doing precisely what it was built to do — skip rather than grow. My machine
returns in four frames, and four is what I had asserted.

The bound is now the only one that holds anywhere: a query cannot answer on the
frame that issued it, and a reading cannot be older than the session that took
it. `GpuTimer` gained a `frames` count so the second half of that is measured
rather than guessed. The lateness and the skip count are still logged every run,
because they are the interesting numbers — they are just not assertions about
somebody else's hardware.

## Captions, and three tests that could not have failed

The caption model got sixteen plants. Thirteen failed something immediately.
The other three are the useful ones, because all three were the tests' fault and
each in a different way.

**One could not distinguish the bug from the fix.** The guard that refuses to
name a direction for a sound underfoot was tested by asserting it comes back
`ahead` — which it does either way, because a point just in front of the
listener *is* ahead. What the guard actually buys is that the answer does not
flip to `behind` when the player turns on the spot, so that is what is asserted
now: two facings, same word.

**One had a fixture that could not discriminate.** Coalescing matches the
*newest* nearby line rather than the first, so a kid spraying along a fence
keeps feeding the line in front of them. The fixture put two lines fourteen
metres apart and the repeat next to one of them — only one candidate was ever in
range, so first-match and last-match agreed and reversing the loop changed
nothing. The repeat now lands seven metres from *each*, and the tell is which
line was left alone, because whichever one coalesces gets moved to the end and
the counts-by-position come out identical either way.

**And one asserted a state that cannot happen.** `expire` walked the list from
the front and then swept it again from the back, with a comment explaining that
the list is not sorted after a coalesce. It is: a coalesced line has its time
refreshed and is moved to the end in the same breath, and a new line is appended
with the newest time, so the list is always ascending. The back sweep was dead
code, the test for it was asserting an impossible arrangement, and a planted bug
in it broke nothing. Both came out; what replaced them is a test that the
ordering invariant holds, which is what makes one pass correct.

## And two red checks in one hour, both mine

**The first**: `scenarios/profile.mjs` asserts structure rather than
milliseconds — its own header says a budget here would be a claim about
GitHub's fleet — and then the GPU checks went in with `latency < 30`. CI failed
at exactly thirty. The bound is now the only one that holds anywhere: a query
cannot answer on the frame that issued it, and a reading cannot be older than
the session that took it.

**The second, in the fix for the first**: `statsLine` turned the readout on and
waited two animation frames. The readout is rewritten on `FrameStats`' own
quarter-second cadence rather than every frame, so two frames is a bet on frame
time — fine at sixty, lost at the seven a software rasteriser manages on a
shared runner. This project wrote that exact mistake up ten days ago about
waiting three frames for a camera blend. It waits for the state now.

## And a funnel that called itself

Every sound worth captioning goes through one `ears` object rather than a
caption call written beside each of fifteen `sounds.*` calls, because two things
that must agree is the shape of bug this repository has lost to three times. The
rewrite was done with a regular expression — which matched the calls *inside*
`ears` too, so `ears.placed` called `ears.placed`. The scenario died with
`Maximum call stack size exceeded` and the tell was already on screen: the script
had printed "call sites rewritten: 15 -> 0", and zero was one too few.

## Paint on the wire, and the eight plants that hold it

The spray can shipped local-only, which for a feature about showing off to
friends is the half that matters. Putting it on the wire needed no new shapes:
`clampTag(raw, by)` was already total and already took the sprayer as a separate
argument, which is exactly the host's job — the design had been built for this
without the wiring being done.

Two rules, both the ones the chat channel and the locker already follow. **The
host clamps what it repeats**, so what leaves is a valid record or nothing;
validating on the receiving end is a convention, and the first client that did
not would be painting every other player's screen. **A client cannot name its
own sender** — no `by` on the wire from a client, stamped from the connection
instead. That one has teeth here that it does not have for an outfit: the cap is
*per player*, so a sprayer who could name themselves would be spending somebody
else's twelve marks and evicting a rival's paint rather than their own.

**No optimistic paint.** Prediction earns its complexity for movement, where a
round trip is the difference between responsive and unplayable. A mark on a
fence is not something anybody reacts to, and predicting it would mean
reconciling a cap only the host can apply — so a guest asks and waits, and the
hiss of the can plays locally and immediately, because that is your own can.

**A late joiner is replayed the fences one message at a time**, exactly as
outfits are, rather than being handed a list on `welcome`. One path a mark
reaches a wall by. Both ends run `addTag` over the same messages in the same
order, so a guest arrives at the host's list rather than an approximation of
it — and the test that says so sprays fifteen marks with a cap of twelve and
checks a newcomer is told about twelve, the oldest three gone.

Eight planted, eight caught: the host trusting a `by` a client put on the wire;
the host repeating what it was sent unclamped; the mark never reaching the other
guests; the sprayer never told about their own; a late joiner told nothing; the
caps never applied to the host's own copy; paint replayed for a part that had
come down; and a guest painting optimistically as well as taking the echo.

## Every bug that was planted on purpose

Each of these was introduced deliberately, to watch one assertion fail, and then
taken out again. An assertion that survives its own bug is not a check — and the
only way to know which kind you have written is to try it. The list is here
rather than in a pull request description because it only grows.

guests building for free, the outcome withheld, markers not sent, wetness
dropped from the snapshot, a networked menu pausing the world, black grass, a
missing horizon, a shared tank, an un-slowed soaked guest, a reverted bot id
range, a sign flip in the aim vector, an un-ghosted slide, a trampoline parked by
a tap, a launch speed raised past its ceiling, a slide pushed backwards, a mantle
without its ground check, a tag with no height check and no cooldown, both halves
of the thaw rule, a host that broadcasts instead of filtering, pings sent to
everybody, a removed rate limit, a team channel that ignores teams, a splash with
no spray, a burst that spawns dead, a microphone never added to the call, voice
that ignores distance, a falloff of the wrong shape, walls that never muffle, an
analyser tapped off nothing, marks that never reach the DOM, a staircase with its
blocks spread apart, a ladder whose rails miss its rungs, a wall with gaps, a
rebind that wipes the pair it was meant to change one key of, an alternate key
that never reaches the game, a d-pad restored to doing nothing, the
un-normalised eye offsets, an eye that ignores head size, a missing neck, a kid
who does not breathe, a breath that reaches the feet, everybody inhaling
together, one build for everybody, per-kid state that is never pruned, one mouth
for every mood, a clamp that lets a slider past its stated range, a host that
repeats a costume without checking it, an appearance that does not survive its
own codec, paint that never leaves the wardrobe, a ponytail drawn on a shaved
head, a height rule instead of the lava raycast, lava checkpoints counted out of
order, a finish placed back inside the respawn, a lawn that never takes anybody,
a dunk that wipes the checkpoints you earned, a sun that never moves, a sun that
never swings, an evening fill that dims with the key, a sun that moves without
invalidating the shadow map, and a day clock unquantised enough to rebuild that
map every frame.

And since: a lamp mesh culled against a bound measured while it was off; a glow
drawn with normal blending instead of additive; each map light deleted in turn;
an instanced count parked instead of lowered; a `canStamp` guard dropped so a
blueprint places whatever fits; the support cascade disabled so a tower reports
one part down instead of three; a house light removed to see whether the check
was really looking at the house; a collapse-volume clamp removed; a collapse
falloff halved to a placement's; and a collapse pitch flattened.

And on the GPU timer, ten in a row, all caught: collecting the query the timer
is still inside; reading the disjoint flag after the results instead of before;
leaving the open query untainted when the driver goes disjoint; a skipped frame
that is not counted; a straggler dragging the reported lateness backwards; a
negative result trusted; a result read without asking whether it is ready — the
one that would stall the whole pipeline; a second query opened while one is
active; a tainted result recorded anyway; and a timer that claims to work on a
machine with no extension.

And on networked paint, eight: a host that trusts the `by` a client put on the
wire; a host that repeats what it was sent without clamping it; a broadcast that
never happens; a sprayer never told about their own mark; a late joiner told
nothing about the fences; caps never applied to the host's own copy; paint
replayed for a part that had already come down; and a guest that paints
optimistically and then takes the echo as well, ending up with it twice.

And on captions, sixteen: the range gate dropped; a collapse carrying no further
than a placement; left and right swapped; behind never reported; a bearing taken
against the world instead of the listener; a direction guessed for something
underfoot; repeats that never fold; distant repeats folded anyway; stale repeats
folded anyway; two different sounds folded together; coalescing against the
oldest line instead of the newest; a repeat that keeps its old place in the
list; a repeat that does not update its direction; the newest line refused
instead of the oldest dropped; and a repeat that does not refresh the age.

And on the boot-time warm-up, nine: a restore that does nothing; a restore that
switches everything on instead of putting back what was off; counts never
lifted; counts never put back; no frame drawn at all; the shadow map not asked
for before the frame that compiles its programs; the shadow map left standing
afterwards; a driver that throws left uncleaned-up; and a traversal that stops
at a hidden branch instead of descending into it.
