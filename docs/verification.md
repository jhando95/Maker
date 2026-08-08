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

## And the clatter, which is a cue rather than a fact

A guest could not hear somebody else's tower fall. The removals were already
replicated — the reason was subtler than a missing message: a cascade arrives as
N separate `unbuilt`s, one per part, so a guest applying them cannot tell a
tower coming down from somebody tidying up a plank at a time. There was nothing
to *infer* it from.

So the noise travels on its own, and the shape of that is the decision worth
recording. **It carries no ids and removes nothing.** The state path is
untouched — a machine that dropped every one of these would still have exactly
the right world — which is what makes it safe to broadcast rather than send per
recipient the way chat and pings are. There is nothing private about a noise the
whole garden makes, and the falloff is arithmetic every client can already do
from its own listener position.

It hangs off `ears.collapsed` rather than off the removal path, so a removal
that is not worth hearing does not become one on the wire just because it
happened to be networked. On a guest the same funnel runs and simply cannot
re-broadcast, because the host branch is false there — one recipe, one falloff,
one caption, wherever the collapse was decided.

Four planted, four caught: the crash never leaving the host; a guest ignoring
one it was sent; the size dropped on the way, so a thirty-part collapse sounds
like one plank; and the place dropped, so every tower falls at the origin.

One of the three tests could not have failed as first written — it asserted on
`status.tick`, which does not exist, so it read `undefined` and threw rather
than checking anything. It reads `build.placedCount` now, which is the actual
claim: this message removes nothing.

## Everybody's water, and a check in the wrong place

`streamFor` had been published per actor since Water War was written and the
renderer took exactly one of them — the local player's. A guest saw their own
jet and never the host's, so the fight looked one-sided from both ends. The
comment in `waterWar.ts` said so out loud and nobody had done anything about it.

The renderer now takes a list, and the fix carried a second one for free: the
old code parked unused droplets at a hidden matrix, which submits every one of
them to the vertex shader to produce no pixels. **Packed rather than parked**,
so a garden where nobody has pulled a trigger costs no draw at all — the same
mistake, in the fourth batch to make it.

**The interesting part was where to check it.** The first attempt sampled
`streamsPublished()` and the droplet count across three hundred animation
frames during a raid and got zero on every one. Nothing was broken: the mode
clears the streams at the top of every tick and only sets them again while a
trigger is held, so a sampling loop that runs *between* simulation steps can
never see one. The scenario's own stream check had that written at the top —
"a single frame landing in that gap wipes the very thing being asserted" — and
it was written after CI found it once already.

So the browser now asserts only what a browser can: that the mode hands the
renderer a hose per person, read in the same call that holds the trigger. What
reaches the draw call is arithmetic over a count, and that moved to
`modeRenderer.test.ts`, where nothing has to be live for there to be something
to look at.

Six planted, four caught immediately, and both survivors were worth the time:

- **An unreachable guard.** `updateStream` bounded its own writes against the
  buffer capacity, but `setStreams` already clamps the hose count and each hose
  is capped at `MAX_DROPS`, so the total cannot exceed capacity and the inner
  check never ran. Two defences for one invariant with only one of them
  reachable — the same shape as the dead sweep in `Captions.expire`. It came
  out, and the test that pushes more hoses than the cap now checks the clamp
  that actually holds: the same list truncated by hand draws the same thing.
- **A test that could not tell a copy from a reference.** It emptied the
  caller's array and expected the picture to survive — but emptying an array
  leaves its elements alive, so a renderer holding those elements passes too.
  It collapses a six-metre jet to zero length now and demands the droplet count
  is unmoved, which only a copy can manage.

## A face in the lobby, and a claim in the PR body that was wrong

The description had been carrying "a locker outfit does not follow you into the
lobby's player list — the appearance is on the wire; the list simply does not
read it". The first half was wrong. The appearance is on the *session* wire, in
the game; the lobby protocol had no appearance at all, so this was a protocol
change rather than a reading omission. Worth recording because the sentence made
a five-file job sound like a one-line one, and it was written by whoever is
writing this.

**Three colours, not an `Appearance`,** and that is the decision. `lobbyProtocol`
is a matchmaker that deliberately knows nothing about the game — it refuses to
carry a player id on the grounds that "a party list is shown on a screen".
Handing it the character model would tie the thing that pairs strangers up to
the thing that draws hair, so the next slider added to the Locker would be a
lobby protocol change. A row in a list can show a shirt, a face and a fringe;
that is what it gets, and `PLAIN_LOOK` is a default rather than an optional
field so no list has to decide what to draw for somebody who never opened the
Locker.

The chip is three coloured boxes in CSS rather than a rendered head, for the
same reason: a canvas and a camera per person in a list that scrolls, to show
what three rectangles already show.

Six planted, five caught at once. The survivor was the interesting one again:
**a clean that coerced instead of checking the type.** The test sent
`skin: 'red'`, and `Number('red')` is `NaN`, which every version of the check
rejects — so replacing `typeof raw !== 'number'` with a coercion changed
nothing. The values that matter are the ones that coerce *successfully*:
`Number(null)` is 0 and `Number(true)` is 1, so a weak clean turns a whole
friend list black because somebody sent a null. The test sends `null` and `true`
now, which is what the comment beside the code had said all along.

## The emote wheel, which was already written down as owed

`main.ts` carried a comment saying emotes cycled "for now", that a radial picker
already existed for parts and weapons, and that this ought to use it — an
admission rather than a design. Paying it off turned out to be small, because
`partWheel.ts` never knew what a part was: a `WheelEntry` is a label, a line of
detail and a colour. So this is a **third content set on one wheel** rather than
a second wheel, and the gesture somebody already learned for parts is the
gesture for this.

The one thing that needed care is that a shared wheel has to remember which
content it is showing. The key that closes it must be the key that opened it —
otherwise releasing the part key while the emote wheel is up picks an emote, and
holding both leaves one stuck open. `wheelShows` is that memory, and the browser
plant that proved the check works landed on exactly it: labelling the emote
content as `build` made the release watch the wrong key, so the wheel opened and
shut inside one frame and the scenario timed out waiting to see it open.

**Three tables describe one emote** — its word, its colour and its place in the
order — and they are only correct together. TypeScript catches a missing entry
in the two `Record`s and cannot catch a short `EMOTE_ORDER`, because an array of
a union is perfectly happy to be missing a member. Four plants on that: an emote
dropped from the order, one listed twice, two wedges sharing a colour, and a
colour a `WheelEntry` cannot use. All four caught.

The detail line is deliberately empty for emotes. Parts have a size and weapons
have a reason they are greyed; "wave" has nothing to add, and a second line
repeating the first is noise in a menu that is open for half a second.

## The blueprint picker, and a hook that proved nothing

`BlueprintStore` has had `save(name, parts, id)` and `remove(id)` since it was
written, and nothing ever called either with intent. Renaming and deleting a
blueprint existed in the model and in no interface; picking one meant tapping a
key until the right name went past. The screen is the missing half.

The first version of the test hook called the menu's callbacks directly:

```ts
hold: (id: string | null) => { menuCallbacks.onBlueprintHold(id); },
```

That is the shape this project normally wants — drive the same calls the buttons
make, rather than reaching past them into the store — and here it is not enough,
because the callbacks are shared with the store. A screen whose buttons were
wired to nothing would have passed. So would one that acted and never redrew,
which is what actually happened: the model changed, the rows did not, and the
one assertion that read the DOM failed. The hook now finds the row by the id the
menu stamps on it and **presses the button**, which exercises the row, the
listener, the callback and the redraw — every one of which has been broken here
before.

Seven plants on that, all caught: Hold acting without redrawing; `mk-held` put
on every row instead of the held one; a built-in offered Rename and Delete; no
way to put a blueprint away; Delete leaving the row on screen; and a rename that
drops the id, which makes a second blueprint rather than renaming the first.

**And one that was missed, for the usual reason.** Deleting the blueprint in
your hand has to empty the hand, or the preview goes on showing a shape that
cannot be stamped. The check was:

```js
const nothingHeld = m.blueprintScreen.list().every((b) => !b.held);
```

Which cannot fail. `list()` reports `held` per row, and a deleted blueprint has
no row — `every` over a list that no longer contains it is vacuously true
whatever the hand is holding. Deleting the line that clears it changed nothing.
Asked of the hand instead (`m.blueprints.held() === null`) the plant is caught
immediately. This is the third time on this project that a check has asserted
over a collection the bug removes the subject from, and it will not be the last:
the tell is an `every` or a `some` whose subject is the thing under test.

## A network that is bad on purpose, and a guard with nothing to guard

`loopbackPair` delivers every message instantly, in order, and never loses one.
Every rule in `session.ts` has been verified against it, which means every rule
in `session.ts` has been verified against a network that cannot misbehave. The
failure modes a real session meets on an ordinary evening — a command that
arrives behind the one after it, a snapshot that never comes, a hello sent into
thirty seconds of dead wifi — have never been exercised at all.

`src/net/unreliable.ts` wraps a `Transport` and gives it four dials and a clock
the test owns. Twelve plants; eleven caught first time. Two design notes worth
keeping:

**There is no reorder dial**, because reordering is not something a network
decides to do — it is what jitter *is*. Delivery is by due time rather than send
order, so reordering falls out at exactly the rate the jitter implies. A second
dial would be a second, disagreeing model of one phenomenon. The plant that
proves it works removes the sort and delivers in send order.

**Both directions get their own generator**, seeded apart. One shared generator
would drop the same packet numbers up and down, which no real network does, and
would hide any bug whose trigger is a one-way hole. The plant is a one-line
change to `unreliablePair` and the assertion that catches it is that the two
directions did not lose the same number of messages.

### The one that could not fail

`hold` clamps the delay at zero, so a jitter wider than the latency cannot
schedule a message in the past. The test drove three hundred messages through
`latency: 0.01, jitter: 0.5` and asserted that nothing arrived before it was
sent. Taking the clamp out changed nothing, and it took a while to see why:

**a due time of zero and a due time of minus four hundred milliseconds are
indistinguishable at this interface.** Both are `<= now`, so both deliver on the
very next `advance`, in the same batch, in the same order. There is no arrival
that can tell them apart. The clamp was not being tested — it was unobservable,
which is a different and worse thing than untested.

Two honest options: delete the guard, or make what it guards visible. The link
now reports `fastest` and `slowest` — the delay envelope it actually applied —
which is a diagnostic a network harness wants for its own sake, because a
condition set that silently failed to apply is a whole suite quietly running on
a perfect network. With them, the clamp is a floor that can be violated and
observed, and the plant is caught immediately.

The assertion also checks that the envelope was *explored* (`fastest` under a
millisecond, `slowest` past four hundred), because bounds on a distribution
nothing sampled are bounds that hold vacuously.

## Three real bugs, found the first time the network was allowed to misbehave

The link from the previous section was built to be pointed at something. Pointed
at a two-player session it found three bugs in an hour, all of them in code that
had passed every test on this project for weeks. That is the argument for the
whole technique, so it is worth being precise about what each one was and why a
loopback could never have shown it.

### A snapshot that arrives late used to be applied anyway

`applySnapshot` took the tick and opened with `void tick`. Ten seconds of
two-player traffic at 120ms with 40ms of jitter delivered seven of about two
hundred snapshots out of order, and all seven were applied on arrival.

What that costs is not subtle. An interpolation sample gets stamped *now* while
carrying where somebody was two frames ago, so the picture of a player walking
in a straight line goes backwards. Reconciliation runs against a stale
acknowledgement. The round rolls back. And the sweep at the bottom — "anyone the
host stopped mentioning is gone" — forgets anybody who joined in the gap, then
re-adds them on the next snapshot with an empty interpolation buffer.

Dropped whole rather than in part, because everything in a snapshot describes one
instant: taking the actors from an old one and the round from a new one is a
third world that never existed.

### A guest read a snapshot before it knew which player it was

Worse, and only reachable if a snapshot can overtake a welcome. Before the
welcome, `this.localId` is -1, so `applySnapshot` treats every actor as somebody
else. It builds a remote for the guest's own future id, and asks the roster for a
remote carrying the host's id — which the roster **refuses**, because an
unwelcomed guest is still id 0 and so is the host. The refusal is silent, the
client records the remote as made, and it never asks again.

The result is a guest who spends the entire session drawing a ghost of itself and
never once seeing the host. The fix is a line: a snapshot cannot be read before
the welcome, because the one thing needed to read one is which of those actors
you are.

The test forces it deterministically rather than waiting for jitter to do it —
the welcome goes onto a link with half a second of delay, then the delay is taken
away, so everything sent afterwards overtakes it.

### A lost welcome was a permanently half-joined session

The client repeats its hello until it is welcomed, which was added when a real
server exposed a dropped one. Nothing repeated the *welcome*. There was no
`case 'hello'` in the host's peer handler at all, so a second hello from an
established peer fell through the switch in silence.

So: the host makes the actor, gives it a side and a spawn, adds it to the roster
and starts simulating it from a stream of commands — and the guest, whose welcome
was the one packet in thirty that went missing, sits on "connecting…" forever
while everybody else watches them stand on the lawn. One lost packet, one player
who cannot play, and no error anywhere.

A second hello means exactly one thing: *I never got your answer*. It is answered
now. Everything in the answer is idempotent by construction — `welcome` carries
the world wholesale and a guest adopts rather than merges, `wearing` and
`sprayed` are last-writer-wins on an id — so answering one nobody needed costs a
message, and not answering one costs a player.

### And two the fix immediately created

Both caught by the existing suite within a minute, which is the system working.

**The first retry fired a sixtieth of a second after the first hello**, because
the constructor sent one and left the counter at zero. Harmless while nothing
answered a repeat; the moment something did, every guest got two welcomes on
every join. The counter starts wound up now — that *was* the first hello.

**And a second welcome re-initialised a player mid-round.** A welcome is an
initialisation: an id, a side, a spawn, and the world wholesale. Applying one to
a guest who already has all four teleports them back to the spawn, throws away
the world they are standing in, and clears the part-id maps everything placed
since was learned into. It is dropped now if the guest is already connected.

That one needed a test written for it specifically, because with the retry
counter fixed no test produced a second hello any more. The condition that does
is a link slower than the retry interval: a quarter of a second each way is a
half-second round trip against a third-of-a-second retry, so a guest *always*
asks again before the first answer can arrive. Six plants on these fixes, five
caught immediately, and the sixth is the one that needed the slow link to exist.

## Two worlds that drift apart, and the smoke alarm that notices

A `built` broadcast is sent once and never repeated. One dropped packet leaves a
guest permanently missing a plank — silently, for the rest of the round, with no
way for either side to find out. A guest standing on a wall the host cannot see
is not a graphical glitch; it is two people playing different games, and it is
the failure this netcode was most afraid of and had no answer to.

`hashWorld` is one number that says whether two machines are looking at the same
world. It rides on a snapshot about once a second, a guest compares it against
its own, and three disagreements in a row buy a request for the world back.

**Order-independent, because the two sides do not agree on part ids.** The host's
are the order it placed them; a guest's are the order they arrived, which a lossy
network reorders and a late joiner gets wholesale from the middle of a game. So
parts combine by addition rather than by mixing one into the next. The plant that
proves it works swaps the sum for a chained mix and the "does not care what order
the parts came in" test fails immediately.

**Hashed from the serialized form**, which quantises to a millimetre and 1e-4 and
is what both sides were built from. Hashing the physics store instead would
compare two numbers that reached the same place by different arithmetic and
disagree in the last bit for reasons that are not a desync.

**Three in a row rather than one**, because a placement can be in flight at the
instant the host hashes, and a guest that asked for the whole yard every time
anybody put down a plank would be worse than the bug.

Twelve plants. Seven caught immediately; four needed better tests; one cannot be
caught at all and is labelled in the source rather than left looking verified.

### The four tests that could not fail, and what each was missing

**The run-of-three had nothing to run against.** The first version placed planks
over a link with half a second of steady delay, on the theory that a placement
would be in flight when the hash went out. It never was — a `built` and the
snapshot carrying the hash travel the *same link*, so a steady delay always
delivers the plank first and no limit at all would have fired. It takes
*reordering* for a hash to overtake the plank it counts. With jitter and no loss
the false alarm is real, and a limit of one fails within a second.

**"The repair is the parts and nothing else" was asserted too late.** The test
walked the guest, forced a resync, and checked at the end that it had not been
teleported to the spawn. It had — and prediction and reconciliation had already
healed it, so the final position looked perfect. What a player sees is the jump,
so the jump is what is measured now: the largest single-tick movement across the
whole run, which a tick of walking keeps at a few centimetres and a teleport does
not.

**Nothing checked that a repaired world was *relearned*.** Host and guest allocate
part ids independently, so "take down part 3" means two different planks unless
the translation table is rebuilt alongside the parts. Deleting the relearn line
changed nothing observable, because the next thing any test did was let the hash
run again. The test now takes a part down sixty ticks after the repair — far
inside the three seconds the hash needs — so the id map is the only thing that
can make it work.

**And a session that was merely lossy was called merely building.** The
"no false alarm" test ran on a 3% link and found four desyncs, which is not a
false alarm: some of the announcements really were dropped and the guest really
did diverge and really was repaired. The premise was wrong, not the code. It is
two tests now — one on a perfect link asserting nothing is ever reported, and one
on a lossy link asserting the twelve planks arrive anyway *and* that it took the
repair to get them there.

### And one that cannot be falsified at all

`hashWorld` mixes the part count in as well as the sum. Without it, a world whose
part hashes happen to add up to zero is the same number as an empty one — and
"nothing has been built" is the state a guest is most likely to be wrongly in.

Removing `count++` breaks no test, and not because the tests are weak. Any
function of `(sum, count)` differs from a function of `(sum)` only on two worlds
that share a sum and differ in count, and there is no way to construct one:
falsifying it needs two parts whose hashes sum to zero mod 2^32, and a search
over two million single-part variants produced no such pair, because `mix` is a
bijection over a contiguous range and its outputs are not birthday-random.

So it stays, it costs one multiply a second, and it is **labelled in the source
as unfalsifiable** rather than left looking covered. That is the difference
between this and the earlier cases: a guard nobody can break is not the same as a
guard nobody checked, and the honest thing is to say which one you have.

An earlier version also nudged a part hashing to zero up to one, on the same
reasoning, with a five-thousand-sample sweep asserting no part ever hashed to
zero — a test that could not fail, guarding a case that could not happen. That
one was deleted outright rather than labelled, because with the count mixed in a
part hashing to zero still changes the world hash: it still changes the count.

## And a fourth red check that was mine, in the same readout as the second

`scenarios/frontend.mjs` turned the frame-rate readout on, slept nine hundred
milliseconds, and asserted it was showing. Green on a developer's machine at
sixty frames a second, where nine hundred milliseconds is fifty-four frames.
Red on a CI runner at five, where it is four — and the readout is rewritten on
`FrameStats`' quarter-second cadence, so four frames is a coin toss.

That is a bet on frame time wearing the costume of a wait, and it is the third
time a scenario on this project has asserted on state it had not established.
It is the *second* time this particular readout has been the one to do it: run
95 was the same element, waiting on two animation frames instead of a timeout.
Fixing it once by counting frames instead of milliseconds was fixing the units
of the bet rather than the bet.

Both directions wait on the state now, bounded at twenty seconds, and the
showing one waits for the *text* rather than for the element — the panel appears
on the frame the setting changes and the numbers arrive on the next stats
update, so "visible" and "written" are two different moments and only one of
them is what the following assertions read. Planted by making the readout never
un-hide; caught.

The general rule, restated because it keeps needing restating: **a scenario may
wait for a condition and may not wait for a duration.** Any duration is a guess
about a machine you are not running on.

## A fixture that hand-wrote its tick numbers

`scenarios/party.mjs` drives a guest by sending it snapshots the host never sent,
which is the right way to test a guest's *reaction* to a round it did not start.
The tick number on each was the first argument and the fixtures typed them by
hand: 1, 2, 3, 6, 7 — and then 4, and then 5.

That was harmless for as long as nothing read the number, and it stopped being
harmless the moment a guest started refusing snapshots older than the newest it
had applied. The round-over snapshot was numbered 4, arrived after 7, and was
dropped exactly as designed. No result screen, and a scenario that sat there
until it timed out.

**The rule is right and the fixture was wrong.** A real host's counter only ever
goes up; nothing else can happen. So the fix is not to soften the rule, it is to
stop the fixture from being able to break it: the tick is generated inside the
helper now and is not a parameter at all. A fixture cannot hand-write a stale
tick if it cannot hand-write a tick.

This is the fourth time on this project that two things which had to agree were
written down twice, and the first time the second copy was in a test rather than
in the game.

**And the wait that was never fifteen seconds.** The same scenario called
`page.waitForFunction(fn, { timeout: 15000 })`. Playwright's second parameter is
the *argument* handed to the function and the third is the options — so the
timeout was passed as an unused argument and the wait ran on the thirty-second
default. It is only visible in an error message that says thirty seconds when
the source says fifteen, which is how it survived until it fired.

## A menu a controller can reach, and four checks that could not fail

Every screen in this project was click-only. There was a gamepad layer and it
drove the *game*, so a player on a controller had to put it down and find the
mouse to change a setting or pick a mode. On a PC that is a papercut; for the
console build this project is now aiming at, it is the whole job, and the cost
grows with every screen added.

The geometry is a pure module with its own tests. The interesting part of the
verification is the browser scenario, where four assertions were written that
could not have failed — three of them the same mistake in different clothes.

**"Something changed" is not "the right thing changed."** The first version of
the stick test pushed down and asserted the highlight moved. Up and down both
move it, so a stick wired upside down passed. It is an *equivalence* now: from
one starting point, pushing the stick down and pressing Down must land on the
same item. That is the property, and it fails immediately when the sign flips.

**"One ring is drawn" was asserted once, before there was a second.** Checking
the ring count after the *first* arrow press cannot catch a highlight that never
takes the old ring off, because at that point only one element has ever had it.
The count is asserted after moving as well now, which is where two would show.

**"The highlight survived" was read off the model, not the screen.** The check
after a change of screen read `menu.focused`, which is derived from an index —
and the index survives a render whether or not anything is drawn. What is
actually lost when a rebuilt card is not re-decorated is the *ring*, so the ring
is what is counted.

**And the layout assumption that was simply wrong.** The scenario walked down the
title screen looking for Settings and never found it, which read as a bug in the
navigation and was a bug in my model of the screen: Free Build, Locker, Saved
Builds, Blueprints and Settings are a single row, not a column. The scenario
walks down and then right now — which is a better test than the one intended,
because it exercises both axes and because it is exactly the case a flat
next/previous cursor gets wrong.

Nine plants on the wiring, all caught: the key listener never installed; the pad
never reaching the menu; confirm and back on the same button; back doing nothing;
the highlight not put back after a render; the ring never drawn; the old ring
never removed; the highlight switched on before anybody asked; and the stick
upside down. Fourteen more on the geometry, twelve caught first time — one of the
two was a no-op plant of mine, and the other was a `reset` whose effect is
indistinguishable from clearing a timer until the step *after* the next one.

## A map in the corner, and a measure too blunt to see it

The compass this game has answers "which way is the flag" and cannot answer
"which way is round". A backyard with a house in the middle is a maze the first
six times you play it, and Tag runs the length of a street.

The design is three layers on three clocks — the neighbourhood baked once, what
people have built rebuilt when `worldChanged()` says so, and people and
objectives every frame — so a frame costs two `drawImage` calls and a dozen
little paths whatever is in the world. Twelve plants on the projection and the
edge-pinning, all caught. The browser half took three passes.

**"Is anything drawn" was measured by counting lit pixels**, which is the right
instrument and was pointed at the wrong threshold. `ink > 500` passes with the
*entire neighbourhood layer missing*, because the player's arrow and a handful
of markers are worth more than five hundred pixels between them. Measured
properly: the map draws about 7,000 lit pixels, and about 2,000 of those survive
deleting the world layer. The bar is 3,000 now, which is a bar only the
neighbourhood can clear.

**And the same instrument was too twitchy at the other end.** "Building shows up
on the map" was asserted as `after > before`, and the player's own arrow moves
two or three pixels between two samples — so a delta of one is noise, and a
plant that stopped the built layer being rebuilt at all passed on it. Eighteen
planks are worth about seventy pixels; the bar is thirty, which is ten times the
noise and half the signal.

Both are the same mistake at two ends of one scale: a measurement with no sense
of how big the thing being measured is. Getting the numbers first — 7,000 with
the world, 2,000 without, +73 for eighteen planks, ±3 for a walking player —
took one throwaway probe and turned three assertions from decorative into
load-bearing.

**And one function deleted rather than tested.** The model started with an
`onMap` that answered "is this box worth drawing", with tests for a fence whose
centre is off the map and whose end is on it. Then the renderer turned out not
to need it: baking the whole world once and blitting a window out of it skips
everything off-screen without asking. A function with no caller is dead code
however good its tests are, so it went, and this is the note saying why rather
than a `void onMap` somewhere.

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

And on the emote wheel, five: an emote dropped from the wheel order; one listed
in it twice; two wedges given the same colour; a colour a `WheelEntry` cannot
use; and the emote content mislabelled as the build content, which makes the
release watch the wrong key.

And on the lobby's faces, six: the look never reaching a friend's list; the look
stored unclamped; nobody starting with a look at all; the party view dropping it
while the friend list kept it; a colour coerced rather than type-checked; and a
colour never clamped to one a screen can show.

And on drawing everybody's water, six: only the first hose drawn; unused slots
parked instead of the count lowered; hoses past the cap squeezed in rather than
dropped; the droplet count no longer derived from the length of the jet; the
caller's array held by reference instead of copied; and last frame's water never
cleared, so a jet hangs in the air after the trigger is released.

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

And on the world hash and its repair, twelve: the hash never sent; a mismatch
that never leads to asking; a run of mismatches that resets on every snapshot;
one disagreement being enough to ask; a host that answers every resync however
fast they come; a cooldown that never ticks down; a resync that re-initialises
the guest like a welcome; a repaired world that never relearns its part ids; a
hash that depends on the order the parts arrived in; position left out of a
part's identity; a part that hashes to zero being invisible; and the count left
out of the world. Eleven caught — the last two after the guard they tested was
either deleted or labelled, because neither could be caught as written.

And on the session over that network, six: a stale snapshot applied like any
other; a snapshot read before the guest knew which player it was; a repeated
hello left unanswered; a second welcome re-initialising a player mid-round; a
first retry fired a sixtieth of a second after the first hello; and stale
snapshots dropped but never counted.

And on the network that is bad on purpose, twelve: a delay allowed to go
negative; delivery in send order rather than due order; no tiebreak, so messages
due at the same instant come out backwards; loss that is silent and never
counted; a blackout that swallows nothing; a close that flushes its backlog
instead of dropping it; both directions sharing one generator; a duplicate
counted but never sent twice; a closed link that still accepts sends; a clock
that never moves; a hostile preset gentler than the mild one; and an envelope
that never widens past its first message. Eleven caught first time, and the
twelfth only after the guard it tests was made observable at all.

And on the blueprint picker, eight: Hold acting without redrawing the screen;
every row lit rather than the held one; a built-in offered Rename and Delete; no
way to put one away; Delete leaving the row on screen; a rename that drops the
id and makes a second blueprint; and — missed first time, against a check that
could not fail — a delete that leaves the deleted blueprint in your hand.

And on the boot-time warm-up, nine: a restore that does nothing; a restore that
switches everything on instead of putting back what was off; counts never
lifted; counts never put back; no frame drawn at all; the shadow map not asked
for before the frame that compiles its programs; the shadow map left standing
afterwards; a driver that throws left uncleaned-up; and a traversal that stops
at a hidden branch instead of descending into it.
