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

Every one of those is the same mistake in a new costume: **asserting on state
that had not been established** — a frame budget standing in for the game's own
clock. The honest read is that `scenarios/voice.mjs` is the most expensive check
here and has been the least trustworthy; it earns its place because nothing else
can prove one browser can hear another.
