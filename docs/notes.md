# What was built, and why

These are the engineering notes for the branch that turned Maker from a thing
one person builds in into a thing a group plays in: networked play, a lobby that
can gather strangers into a round, and the world, the movement and the talking
to make one worth playing.

They live here rather than in a pull request description for a plain reason. The
description grew with the branch until it came within two hundred characters of
GitHub's 65,536-character limit with a feature still to add, at which point the
choice was to start deleting reasoning or to put it somewhere that has no
ceiling and can be read against the code it describes. This is that place. The
verification record — every assertion checked by planting its bug, and every
test that turned out not to fail — is next door in
[`docs/verification.md`](verification.md).

Ordered by what a reviewer probably cares about most. Sections below the first
are summarised to what changed and why; the reasoning that used to sit under
each of them is in the code, where the next person will actually meet it.

---

# 1. What you build has to hold itself up

The title screen has said *"Build it yourself. Then find out if it holds."*
since the first commit, and nothing ever found out. A placement was checked for
overlap and for bounds and for nothing else, so a tower stood whether or not it
had legs — knock the bottom plank out of a six-metre staircase and the remaining
five metres hung in the air, unbothered. That was the largest gap in this game
between what it says it is and what it does.

Every part is now standing on the lawn, nailed to something that was already
there, or joined by a chain of parts to one of those. Break the chain and
whatever was on the end of it comes down, **including the kid standing on top**.

**Contact counts in any direction**, and that is a decision about what these
things are. This is not masonry, where a block rests on the one below and
gravity does the rest — it is a kid with a hammer, and a plank nailed to the
side of a post is held by that post as surely as one laid on top of it. Half of
what people build here is cantilevered off something: a rung on a wall, a shelf
off a fence, a bridge out over the pool. A rule that only counted what was
underneath would refuse all of it.

**It runs on removal, not on placement.** Both are true statements about a
structure and only one of them changes how the game plays. The snapper puts
parts against surfaces, so everything anybody has ever built here is already
supported and refusing an unsupported placement would mostly be a rule nobody
meets; collapsing what loses its footing is a rule everybody meets the first
time they take a leg out of something. The interesting half is the cheap half.

**The search is local.** Taking one part away can only strand parts that reached
the ground *through* it, so the flood starts at the hole and works outward,
stopping the moment a component finds an anchor. A component that does not has
been fully enumerated by the time that is known, which is exactly the list to
bring down — no whole-world sweep on every click.

`support.test.ts` runs the local flood **and** a whole-world recomputation
against every part of four shapes and demands they agree. That is the only check
that would catch the fast path getting clever and wrong, and it is the reason
the fast path is trusted.

**The host decides what falls and sends the list.** `applyRemove` is now the
guest's one-part version: a guest running its own collapse off the first of
those messages would be a second opinion about the shape of the world, which is
the definition of a desync and one that only shows up when a tower comes down.
Ids come back sorted, because the order is the order of the messages on the
wire.

**And it sounds like one.** A wooden clatter — four knocks over a third of a
second, each lower and softer than the last, over one dull thump for the mass of
it — scaled by how much came down and stopping at ten parts. One recipe rather
than N removal sounds, and that is not tidiness: the bus has a voice cap, and a
thirty-part collapse spending every voice it has would take the footsteps, the
water and everybody's chat down with the tower. It carries **forty-eight metres
against a placement's twenty-four**, because a tower coming down across the
garden is the only warning the person who built it is going to get.

`scenarios/collapse.mjs` is the part that could not be checked anywhere else: it
stamps a real three-part tower on the lawn, stands a player on it at **3.16m**,
confirms that taking the *top* off brings down only the top, then takes the leg
out and finds the player back on the grass at **0.00m**. A list of ids is not a
collapse; a kid who was three metres up and is not any more is.

## And the preview says so before the wood is spent

That rule left an asymmetry: taking a leg out can no longer strand a part,
because whatever it was holding comes down with it — but *placing* still can,
and a plank hung in open air stays there. The ghost had two states, legal and
illegal, and neither of them means "this will stand on nothing".

`wouldStand` is the mirror of `collapseAfter`: one asks what is stranded when a
box empties, this asks whether a box would be stranded if it filled. It floods
rather than looking at what a placement touches, and that is the case that
matters — the warning is a *warning* rather than a refusal, so a player who
ignores it leaves a floating part behind, and the next plank nailed to that one
would otherwise be called supported by something that is not.

Said with a **pulse rather than a third colour**. Two hues are already spoken
for and one of the two palettes is the colourblind pair, where a third would
have to sit between blue and orange. Motion is a channel nobody is missing, and
it reads as "careful" rather than as "stop" — which is exactly the difference
between this state and an illegal one.

The reachable case turned out not to be "aim at the sky": the snapper hides the
ghost when the ray meets nothing, so a single placement is always against
something. It is a **stamp**, which anchors on one surface and can leave its far
end in the air — and then anything nailed to that far end.

## And the kids will take a fort apart

Bots had never touched the build system. Not rarely — there was not one
reference to it from `bot.ts` or from any mode, which means that in a game whose
first line of README is *party games played inside the things you build*, the
opposition could not interact with anything the player built except by walking
into it. A fort was a shape that made pathfinding fail.

A raider that has spent long enough getting no closer to what it came for now
puts both hands on whatever is in the way, and after two and a half seconds it
comes off — along with everything it was holding up. It goes for the **most
load-bearing thing within reach** rather than the nearest, and that choice is
the design: nearest-first makes a fort a pool of hit points and the answer is
more planks; most-load-bearing makes it a structure and the answer is a second
way to the ground. It is the first time in this project that *where* the wood
goes has mattered more than how much of it there is.

**The measurement changed the design, and that is the part worth reading.** The
first version hung the pull off the state a bot already reaches when every
diversion is blocked — a kid pressed against a wall with no way round, which
seemed like exactly the right moment. Against a real ring wall that branch fired
**zero times in sixty seconds**: the diversion probes reach two radians either
side, and from outside a round fort those always find open lawn, so the kid
circles it forever perfectly content. "Cannot get closer" is what "the fort is
working" actually means — circling holds the distance to what is inside exactly
constant, and a way in reduces it. An open fort is still beaten by walking
through the gap, and there is a test that says so.

The bot only *names* the part; the mode does the demolishing, because the mode
is the object the host runs. A pulled part sounds exactly like a collapse the
player caused. Scoped to Fort Defense — the bot exposes what it is hauling on
and a mode opts in.

---

# 2. A can of spray paint in slot nine

Everything else in this project is a rule about winning. This one cannot hit
anybody, block anybody, hold anybody up or take anything away, and a round plays
out exactly the same whether or not a single tag exists. It is here because a
game four friends play in a back garden is partly about leaving something behind
— a name on the fence, something rude on somebody else's fort.

**It added no geometry.** A tag is one of the eleven flat polygons the locker
already paints a shirt with, turned to face along the surface normal and pushed
four millimetres out along it. One instanced mesh per shape, and a shape nobody
has sprayed has a count of zero. Eleven shapes in eight colours is 88 tags, in a
project that still has no texture pipeline.

**It is a ninth thing to hold, not two more keys.** Every key a left hand can
reach was already bound, and putting the least important feature in the game on
the least reachable key is how a toy stops being used. So the can sits beside
the eight parts: while it is out, the place button sprays and the part-cycling
keys change the tag.

**The caps are part of the mechanic rather than a policy.** Spray your twelfth
and the next one takes your own oldest — nobody is ever told "no more paint",
you simply cannot occupy more of the garden than your share. Eviction is by the
sprayer, deliberately: a rule that took somebody else's oldest would make a can
of paint a weapon, and this is the one system here that is not allowed to be
one. A world ceiling sits behind it.

**Paint goes down with what it was painted on**, which is why a tag records a
part id at all. The pruning is in `worldChanged()` — the one funnel every
removal already goes through — rather than at each call site, where it would
eventually be forgotten at one of them.

**And it can be switched off.** Settings → Playing → Spray can, on by default.
It is the one feature here that exists purely to be silly and the one that can
be used to annoy somebody, and a host who decides their lobby does not want
paint on the fence should not have to ask anybody to behave.

It is on the wire now, and section 22 says how. It was local for a while, which
for a feature about showing off to friends is the half that matters, and the
record being the wire format from the first commit is what made the host path a
small job rather than a rewrite.

---

# 3. Where the frame actually goes

The readout this project had answers *how fast* — frames a second, frame time,
the worst frame in two seconds. It could never answer *what was slow*, and those
are completely different questions. `tools/bench.ts` times systems in isolation
on a synthetic world, which is the other half and not this one: it cannot say
what a live frame in Tag spends, because it never runs one.

Named, disjoint spans — `sim`, `net`, `anim`, `draw`, `ui` — carved out of the
real loop, averaged over two seconds, on the readout beside the frame rate and
readable from a scenario. Flat rather than nested, so nobody can disagree about
whether "sim" includes "physics". Every buffer is a `Float64Array` sized at
construction and `read()` fills a caller-owned array, because a profiler that
allocates is a profiler that causes the stutter it is measuring.

**The leftover is always reported**, and that decision earned itself back on the
first run. In an empty yard: `rest` 190ms (88%), `draw` 24ms (11%), `sim` 0.9ms,
`ui` 0.2ms, `anim` 0.08ms, `net` 0.01ms. In Tag with six kids, `rest` 97%.
Almost the whole frame is outside everything this project instruments, because
the harness rasterises in software and the time goes to the compositor. Without
the leftover the readout would have said "draw is the biggest thing, 11%" with
total confidence and never mentioned the 88%.

That is also a caution about every performance number this repository has taken
from CI, and it is why `scenarios/profile.mjs` asserts **structure rather than
milliseconds**: that the parts add up to the whole, that nothing is negative,
and that the attribution moves when the work does — simulation goes from 0.89ms
on an empty lawn to 3.08ms in Tag. A budget asserted there would be a claim
about GitHub's fleet. What it leaves behind is the table in the CI log.

## And the first thing it found

Draw calls go from 178 in an idle yard to 390 in Tag, which should be impossible
if the character rig is instanced. It is: the characters are innocent. The
scenery is not.

`PropBatch` keys instances by exact dimensions, and `scene.ts` has said for
weeks that "a size used once is a draw call". Nobody had measured the
consequence. Measured: **424 prop meshes carrying 3,880 instances — 174 of them
holding exactly one instance and 70 holding two.** Seventy per cent of the
meshes carrying thirteen per cent of the boxes. An instanced draw with one
instance is a bind, a uniform upload and a draw call, for one box, plus the same
again for its outline shell.

So the tail is merged instead. Under five instances a key is baked into shared
geometry: matrices applied to the vertices, normals through the normal matrix,
and the per-instance colour written **per vertex**, which is what turns a
hundred differently-coloured boxes into one draw. That is the other half of the
trade every batcher makes, and this one had only ever made the first half —
instancing wins when one shape repeats, merging wins when many shapes do not.
Grouped by cell as well as by outline treatment, or a merged object spanning the
neighbourhood would be either entirely in the frustum or entirely behind you,
undoing the culling the chunking exists to buy.

- prop meshes **424 → 146**
- meshes holding a single instance **174 → 0**
- draw calls at the smoke viewpoint **178 → 138**, down 22%
- triangles **135,518 → 138,158**, up 1.9% — the cost of de-indexing, and the
  trade this is

And the verification that matters for a change that rewrites every static object
in the world: the same frame, shot with the change stashed and with it applied,
differs by **0 of 921,600 pixels**. I had looked at that screenshot first and
concluded it was broken.

## And what a stopwatch on the main thread cannot see

The leftover above is 88% of a frame, and the profiler could not be narrower
than "outside everything this project instruments", because the main thread is
not where the pixels happen. `draw` is 28.7ms of *submitting*. Whether the GPU
then spent one millisecond on those commands or three hundred is a question
`renderer.render` cannot answer: it returns when the queue is full.

`EXT_disjoint_timer_query_webgl2` asks the only party that knows, and the file
is mostly about its traps: **the answer is late**, and reading it before the
driver has it stalls the CPU on the GPU — a profiler that flattens the frame
rate it measures and reports the flattened number, so this only ever polls;
**a disjoint invalidates everything in flight**, and the flag is read *before*
results are collected, because reading it clears it and a result collected first
escapes the check it was meant to be covered by; **the pool is fixed**, because
one that grows whenever nothing has come back grows without bound on a driver
that never answers; and **most machines do not have it**, so absence is the
ordinary case and no call site branches on it. Tested against a fake context
that throws on the two mistakes a real driver takes silently. Ten planted, ten
caught.

**And the finding, on the machine nobody expected it to work on.** SwiftShader
does expose it. An empty yard is 28.7ms of CPU submission against **374ms of
reported GPU time**, on a 250ms frame. More GPU milliseconds than the frame has
is not a contradiction — SwiftShader rasterises across worker threads and
`TIME_ELAPSED` sums them — and the reading that settles it is the lateness,
stable at four frames in all three scenes, where a renderer genuinely that far
behind would fall further behind every frame. So the 88% is rasterisation, with
a number on it instead of an inference.

`scenarios/profile.mjs` asserts the readout agrees with the machine rather than
that the extension is present: live, and the HUD shows a figure that is sane and
a few frames late; absent, and the line is missing and nothing has been invented
— no zero that reads as "the GPU is free".

## And whether a long session grows

Every other check here asks whether something *works*. None asked whether doing
it two dozen times costs more than doing it twice, which no unit test can reach:
a leak is invisible in the code that causes it and in a thirty-second playtest,
and arrives three weeks later as "the game gets worse the longer you play".

Twenty-four identical rounds of building, painting, demolishing, nightfall and a
mode change, through the real entry points — a soak that called
`PropBatch.rebuild` directly would pass with the whole build path leaking — then
geometries, textures, programs and the size of the scene graph. The last because
those are two different leaks and only one shows up in `info.memory`.

**Two halves rather than a threshold.** Real growth over the first twelve cycles
was +5 geometries, because `info.memory.geometries` counts an *upload* rather
than a construction. A threshold loose enough to allow that is loose enough to
allow a small leak forever. A cache flattens and a leak keeps its slope, so the
assertion is that the **second** twelve grow by nothing at all.

It passes, and getting it to *fail* took three attempts — written up in
[`docs/verification.md`](verification.md), because the two that survived
are the useful part. Chasing them turned up why nothing leaks here, which is a
design fact rather than luck: **every render batch allocates at construction and
mutates counts afterwards**, so a round never builds a mesh.

## And compiling the shaders before anybody is watching

The soak also *measured* something worth fixing: WebGL compiles a program the
first time a material is **drawn**, so the count climbed through the first
rounds, and each of those is a frame the driver spent compiling — the hitch on
the first flag, the first spray, the first time it gets dark. Do it on the title
screen instead. `renderer.compile` alone does almost nothing here, for two
reasons that each took a measurement.

**It never descends into what is hidden**, because it walks the scene the way a
render does — and hidden is the state of every flag, crate, balloon, lamp glow
and tag shape in this game. Handed the scene as it stands it warms the lawn and
the fence, the two things that were never going to hitch. Forcing visibility
reaches **70 hidden objects**, and the restore puts back exactly the set that
was off: a warm-up that leaves one marker showing is a flag floating over an
empty lawn, which is worse than the stutter it fixed.

**And a shadow is a second pass**, with its own material per caster, and the
only way to compile a pass is to run it. So it renders one frame with everything
visible — then invalidates the shadow map on the way out, because the one it
just drew has a shadow for every hidden object in the world in it, and that map
is static enough to keep it all round.

**And one program still compiled mid-round**, the first time Tag ran, which
took four failed probes and then a different question. Nothing was missing —
`setColorAt` creates `instanceColor` on first use, and the presence of that
buffer is part of a shader's identity, so on a title screen where nobody has
been coloured the warm-up compiled the no-instance-colour variant of every
character mesh and the real one was still to come. An object was in a different
*shape* than it would later be. Allocating the buffer at construction, filled
with white so an uncoloured instance draws exactly as it did, makes a mesh look
the same to the compiler at boot as in the tenth minute.

Measured: geometries uploaded at boot **174 → 204**, the soak's first-half
geometry growth from +5 to **flat**, and programs across twenty-four rounds
**18 → 18 → 18** — one *lower* than before, because unifying the state removed a
variant rather than adding one. The soak asserts zero mid-round compiles.

---

# 4. From "paste this URL" to "press Play"

Two browsers could share a lawn, as long as one of them typed a websocket
address into the other. That is a demo, not a game.

```bash
npm run server     # one HTTP server: / relays a round, /lobby matches people
```

**An identity that outlives a tab, and is not an account.** A uuid and a
six-character friend code in `localStorage`. No email, no password, no
server-side record of a person — `identity.ts` says out loud that this is **not
authentication**, and the honest mitigation is that there is nothing behind it
worth stealing. The alphabet is Crockford's minus vowels, so a code cannot read
as a word and `O`/`0` cannot be confused when somebody reads one down a phone.

**Friends, parties and a queue**, all addressed by friend code and never by
player id — `lobbyCore.ts` cannot leak one, because it never puts one in a
message. A party travels together by construction: the matchmaker gathers whole
parties or none, so a group is never split across two yards, elects a host, and
lands everybody in a **fresh** yard. That last part is why the queue is worth
having: joining a stranger's half-built lot is a worse first thirty seconds than
four people arriving at an empty one together.

---

# 5. Talking, pinging and waving

Playing with other people and having no way to say anything to them is most of a
party game missing. Chat, pings and emotes look like three features and are one:
somebody produces a thing, some subset of the people in the world are entitled
to receive it, and it lives on their screen for a few seconds. Written
separately, that audibility rule gets written three times and comes out subtly
different three times — which is how a game ends up with team chat that is
private and team pings that are not.

So there is one rule in one place, and the split that matters is a different
one:

- **Who is entitled to hear this** is decided by the host, per recipient, and
  nothing a client does can widen it. Team chat is not sent to the other team at
  all. The tempting version broadcasts everything and lets each client show what
  it should — which works until somebody runs a client that does not, and then
  the other team has been reading your callouts all game. A filter on the
  receiving end is a convention, not a rule.
- **Whether you want to hear it** is decided by the listener, locally, and needs
  no wire traffic. Muting is a statement about your own screen; sending it to
  the host makes it something that has to survive a reconnect and, worse,
  something the muted player could in principle be told about.

Audibility travels; mutes do not. Proximity is measured **once, when the line is
said**, rather than continuously: a message that vanished from your log because
the speaker walked away is one you had already read, and one that appeared late
because they walked back is worse. Shouting is an event, and an event happens at
a time and a place.

## And the water can be heard, and seen

`AudioBus.openLoop` is the first sound in this game that keeps going and moves,
which needs something the one-shots never did: the gain has to be **ramped, not
assigned**. Setting `gain.value` sixty times a second clicks on every change,
and sixty clicks a second is a buzz at the frame rate — the most common way
procedural audio goes wrong, and it sounds like a broken speaker rather than
like a bug. One loop moves to the nearest running tap rather than one per
source, because the ear cannot pick out which of two taps forty metres apart it
is hearing. A drained tap goes silent, which is a cue Water War never had: you
could hear a source you had already lost.

A splash was one translucent sphere that expanded and held. That shape in grey
is a smoke puff and in orange is an explosion — it says *something happened
here* and nothing about what. What makes an impact read as **water** is that
pieces of it come off and fall, so the sphere keeps its job of marking the spot
and a handful of droplets do the describing. They spray up and out rather than
in a sphere, because a splash on the lawn throws nothing downwards and one on
somebody's back throws nothing into them.

Both pools are now **packed rather than parked**: the pool slot and the instance
slot used to be the same number with unused ones pushed to y = -9999, so the
draw was always for the full pool — and nothing is splashing during the great
majority of a round. Writing live ones into the front of the buffer and setting
`count` lets three.js skip the draw entirely at zero. The idle yard goes from
179 draw calls and 136,798 triangles to **178 and 135,518**, which is exactly
the sixteen invisible splash spheres. The effect was added and the frame got
cheaper.

## And for somebody who cannot hear any of it

An accessibility feature that is also a gameplay one, which is why it is here
rather than on a list. The collapse sound carries forty-eight metres against a
placement's twenty-four, and `gameSounds.collapsed` says why: in a mode where
two people are dismantling each other's forts it is the only warning the other
one gets. A player who cannot hear it is not missing flavour. They are missing
the warning.

**The rule the whole file is built around: a caption may not say anything the
sound would not have.** Same range, same silence. It is tempting to caption
everything — the model knows where every event happened and the screen has room
— and that would quietly turn an accessibility option into wallhacks, telling
you about a kid spraying a fence forty metres away through a house. In a party
game played between friends, making the accessible option the strong option is
its own kind of exclusion. So every kind carries the range of its own sound, the
table sits in one place where a drift is visible, and a test walks every kind
and checks both sides of its edge.

**Coalescing is most of what makes it readable.** A thirty-part tower plays one
clatter, not thirty, so it must not make thirty lines; spraying is five hisses a
second while somebody draws. Repeats near the same place inside a short window
fold into one line with a count, matched against the newest nearby line rather
than the first, so somebody walking along a fence keeps feeding the line in
front of them. Four directions rather than eight, split on the diagonals, so
`ahead` is the ninety degrees being looked at and `behind` is the ninety that
cannot be — which is the one that matters and the reason any of this exists.

Every sound goes through one `ears` funnel rather than a caption written beside
each of fifteen `sounds.*` calls, because two things that must agree is the
shape of bug this repository has lost to three times. Off by default, under
Settings → Playing. Sixteen bugs planted; the three that failed to break a test
were all the tests' fault, in three different ways, and are written up with the
dead branch they turned up.

---

# 6. Hearing each other

Positional voice over WebRTC. Peer to peer, panned and attenuated by where
everybody is standing, muffled by whatever is between you.

Every *decision* is in `voiceRules.ts` as arithmetic over numbers — audibility,
the falloff curve, who dials whom, what counts as speech, how much signalling
one person may send — with 39 tests. `voiceChat.ts` is the thin platform shell
underneath. **That split is the whole design**, because voice is the first
system here whose failures are all silent: a gain ramp that is subtly wrong
sounds like a bad connection, an offer sent from both ends sounds like a
dropped call, a speaking gate with no hysteresis looks like a flickering icon.
None of them throw, and none can be found by reading the code that causes them.

---

# 7. Saving a thing you built, and putting it down again

Every round of Water War starts with the same ninety seconds of rebuilding what
you built last round. The fort is the point; re-typing the fort is not.

A blueprint is a list of `PlacementRecord`s relative to an anchor — the same
shape the save format and the wire format already use, which is why this is
small: no new serialization, no new validation, no new apply path. A stamp is N
ordinary placements with the offsets added in.

---

# 8. The floor is lava, and building is finally the game

A deep evaluation of the whole thing, and its finding was uncomfortable: **the
game is called Maker, its premise in the first line of its own README is party
games played inside the things you build, and none of its four modes was about
building.** Take the build system out of Capture the Flag and you still have
Capture the Flag. Water War gets a wall that buys you a second, Fort Defense a
fort to stand behind, Tag none at all. In every one of them building is a
support activity for a game that is really about reaching a place or hitting a
person.

So: the grass is out of bounds. Get round the garden — the treehouse, the rain
barrel, up onto the porch roof — without standing on the lawn. Sixty-six metres
of it, none of which you may walk. There is no fighting, no ammo and nothing to
defend; the only verb is getting somewhere, and the only way to get anywhere is
to make a floor.

---

# 9. A locker, and a face worth putting in it

Everybody was a kid drawn from their own actor id: skin, hair and head size
seeded from a number, deterministic, and completely out of the player's hands.
That was a networking decision — the same person looks the same on two machines
that have never spoken, and nothing has to be sent — and it is the right default
and the wrong ceiling. In a party game the first thing you want is to be *you*,
and the second is to be able to point at somebody across the lawn and say which
one they are.

So appearance stops being derived and starts being **chosen, bounded, saved and
sent**. The seeded look is still there and is still what a bot gets and what a
player starts from; it is now a default rather than a fate.

## Within the model, and provably so

The ask was shaping that a player can push without leaving the model behind, and
that is a claim you have to be able to *check* rather than intend.

`clampAppearance` is total: it takes anything — a hand-edited localStorage blob,
a hostile packet, a build from six months ago — and returns a valid appearance.
Every slider is a 0..1 knob mapped into a stated range, so out of range is not
representable rather than merely discouraged, and **height is not a knob at
all**. The joints are tied to `CAP_HEIGHT` precisely so the drawing and the
capsule cannot disagree about how tall somebody is; a kid drawn taller than
their own collider has feet that float, or a head that clips a ceiling they can
walk under. Width, head size, hair and face are yours. Height is the map's.

The test that matters sweeps every extreme of every knob together — not one at a
time — and asserts the drawn body still fits inside the capsule that collides.
Sliders that are each individually safe and jointly are not is exactly the bug a
one-at-a-time test cannot see.

## Eyes that look like eyes

A face was two dark discs. That reads as a doll from two metres and as nothing
at all from ten. An eye is now **a sclera, an iris in a colour you pick, and a
pupil**, with a brow above it — four parts where there was one, and the brow is
the one doing the most work. Eyes alone give a face a direction; a brow gives it
an expression, and it is a box.

Face-on that is the difference between a mannequin and a kid. In profile it cost
nothing, because the whole stack is flattened along the face's own normal — the
same rule that stopped the old eye standing a third of a head proud of the
skull.

## Paint, and why it is marks rather than a canvas

The obvious reading of "let players paint themselves" is a texture: a small
canvas, a brush, a bitmap per player. It is the wrong build here and the reason
is structural rather than a matter of taste. Every character is drawn by
instanced meshes sharing one material — that is what makes the whole cast
twenty-odd draw calls — and a bitmap per player is per-instance texturing, which
means an atlas, an instanced attribute, a patched shader, and UVs on geometry
that has none because `chamferedBox` builds its own positions. Then a 16×16
design on a half-metre chest is four visible pixels at the distance a round is
played at.

What reads in a cel-shaded world of flat colour and heavy ink is **a bold flat
mark**. So paint is up to three of them, each a shape from a library, a colour,
a size, a turn and a place to put it — chest, back, either sleeve. Twelve shapes
built from polar arithmetic rather than authored: a stripe, a chevron, a star, a
bolt, a splat, a ring, a heart, a number plate. That is a costume somebody can
be proud of, it is legible at forty metres, and it costs one draw call per shape
*actually in use on screen* rather than one per player.

## The preview is the actual player

A locker with a doll in a box beside it is two characters to keep in step, and
the one in the box is the one that lies. Opening the Locker puts the camera in
third person over the real player on the real lawn, and every change lands on
the body a moment later through exactly the path a network update uses. There is
nothing else to get wrong, and no preview to be right when the game is not.

## Presets, and what travels

Outfits save to localStorage by name, the same shape as saved builds — one key
each, so a corrupt slot cannot take the rest with it. And an appearance
travels: `wear` from a client, `wearing` from the host, protocol 6. Two rules
about it, both the same rule the chat channel already follows:

- **The host clamps what it receives before it repeats it.** A client can send
  any bytes it likes; what leaves the host is a valid appearance or nothing.
  Validating on the receiving end would be a convention rather than a rule, and
  the first client that did not would be dressing every other player's screen.
- **A client cannot name its own sender.** There is no `from` on the wire; the
  host stamps it from the connection. Otherwise "wear this" becomes "make *that*
  person wear this".

A late joiner is told what everybody is already wearing, because the alternative
is a lawn of default kids that quietly become themselves the next time each one
happens to change something.

---

# 10. The world has an edge, and you cannot get past it

Three separate holes, all found the only way a boundary can be found — by
walking at it for twenty seconds — and none of them visible to a unit test.

- **The ground was an infinite plane.** You could sprint away from the
  cul-de-sac indefinitely, and the neighbourhood simply receded.
- **The fence was a picture.** Scenery, with no collision on it at all, so the
  thing that visually says "this is the edge" was the one thing you could walk
  through.
- **A body under the world wedged in place.** Depenetration pulls a fallen body
  to a −1.19m ledge *inside* `step`, which meant a floor check at −2 could never
  fire. Measured: legitimate landings bottom out at 0.004m, so the floor sits at
  −0.5 and catches a fall without ever catching a landing.

---

# 11. A kid can haul themselves over a ledge

`MANTLE_MAX_HEIGHT` was a constant read by no code at all. It had nonetheless
sized the lumber budget and written a design note in the README — a mechanic that
existed only in prose. **It exists now**, and the constant means what it says.

Three heights, and the table is in `constants.ts` rather than in anybody's head:
up to `STEP_HEIGHT` you walk over it; up to `MANTLE_MAX_HEIGHT` you press jump
against it and give up 0.42 seconds standing still; above that you go round, or
you build.

---

# 12. Two things in the garden that move you

A trampoline off the end of the porch and a slip-n-slide down each side of the
house. **Every effect changes velocity and nothing else**, and that line is what
makes them free over a network: the answer is a pure function of where a body is,
so the host and a guest predicting itself reach it on the same tick and nothing
is ever sent. The first item that has to be *consumed* stops being expressible
this way and goes through the host — that one will not live in this file.

Three things went wrong, and each one passed a test before it was caught.

**The placement re-tuned a mode.** A trampoline two and a half metres from the
garden tap failed three of Water War's balance measurements on the spot, and
rightly: those build rings of planks out to 4.2m and measure what the wall
saves, so a solid prop inside one is a wall nobody paid for. `SOURCE_KEEPOUT`
came out of that and is **necessary and not sufficient** — a second placement
nearly ten metres from the closest tap still tripled one number, because it
stood in a corridor every raiding kid walks down. Five candidate positions were
measured; four left every number untouched.

**The launch was sized against the wrong gravity.** Gravity here is 23 m/s², so
9.6 m/s reached two metres and not the four the comment claimed. It is 11.8 now,
which clears the porch roof at 2.73m and deliberately reaches neither the
treehouse deck nor the eaves — the last stage of the climb is the part you
build. The apex is derived from `GRAVITY` in a test, so nudging the number up to
make a bounce feel better fails the test that says what the bounce is for.

**The slide lost an argument with the character controller.** It eased toward a
target the way a walk does, and measured on the map it moved a player at 2.2 m/s
against a nominal 11 — because `applyItems` runs after `step`, and a body with
no input on it is one the controller is actively stopping. It states the
along-axis speed outright now, with `SLIDE_SPEED` for what gets stamped on and
`SLIDE_TRAVEL` for the ground actually covered, measured through the real
step-then-item pair so tuning movement feel cannot move the slide quietly.

---

# 13. Tag, and the neighbourhood it is played in

Freeze tag. One kid is It, a touch freezes you where you stand, and a runner who
stands beside a frozen friend for a moment thaws them out.

Freezing rather than converting, and **nobody is faster than anybody** — the same
decision twice. Ordinary tag needs the chaser to be quicker, and a quicker chaser
on open ground makes "keep running" the only answer there is. Freezing is
cumulative, so It never has to catch the fastest runner; and thawing hands the
pressure back, because the moment a friend goes down there is a place on the map
somebody has to visit and It knows where it is.

---

# 14. Everybody plays the round, and everybody fights in it

Multiplayer was Free Build only. The host could start Capture the Flag and a
guest would stand on the same lawn seeing none of it.

**A guest wears the round rather than running it.** `RemoteMode` is a `GameMode`
that computes nothing — `hud()`, `markers()`, `finished`, `won` and `summary()`
all come from the last packet, and `fixedUpdate` is empty and always will be.
Everything downstream already reads a mode through that interface, so the banner,
the compass, the build gate and the result screen needed no changes at all. That
only works because modes have never rendered; `gameMode.ts` has said from the
start that this is "what will let a server run a mode headlessly", and this is
the other half of that bet coming due.

---

# 15. The rest of the netcode

**Host-authoritative**, bought for two things worth more right now: no deploy
target, and no dependence on two CPUs agreeing about a square root. The
determinism tests prove a round replays identically *in one process*; they say
nothing about float portability, and lockstep would depend on exactly that.

**Prediction, and the measurement that matters.** A guest moves the moment you
press a key; when a snapshot says where it really was at tick T it replays every
input since, so a correction moves you by the size of the *error*, not the
*latency*. Measured at **under two centimetres**.

---

# 16. One rig draws everybody

The local player was a blue capsule with a yellow ball on top; bots were limbs
assembled inline in the mode renderer. A screenshot with both in it looked like a
bug.

Three things make a kid read: **ink** (every solid thing in this world has an
outline and the characters were the one thing that did not), **a face**, and
**being different from each other**.

## Then it was photographed from the side, and there was a third

**The eyes hung a third of a head off the front of the skull.** They were placed
at the offset `(0.37r, -0.14r, -0.97r)`, which reads as "just inside the
surface" and is nothing of the sort: that vector is **1.048r long**, and the
eye's own radius added another quarter of a head on top of it. Face on it looked
perfect. In profile it was a black bead stuck to the temple — precisely the
class of thing only a screenshot from a second angle ever finds, and the same
class as the two above.

A direction is chosen, normalised, and *then* scaled by the radius, so the
number means what it says. Everything on the face is flattened along the face's
own normal too: a sphere on a sphere is a bead from any angle that is not
straight on.

Three more came out of the same set of photographs.

- **There was no mouth.** Two dots on a blank face is a doll. The third mark is
  what makes it a kid and it is one more box. It goes round and open when
  somebody is stunned, which is the only expression in the game and costs a
  different scale rather than different geometry — the shirt already says "out
  of the fight" at forty metres, and this says it at four.
- **They were bald from behind.** The hair slab reached about six-sevenths of
  the way across a head two radii deep. Front on nobody could tell. The back is
  the view you have of somebody running away from you, which in a game about
  chasing is most of the views there are.
- **Four of them standing on a lawn were four statues in identical poses.** They
  breathe now, out of phase with each other, and their arms drift with it. A
  person who is completely still is not a person. The legs are deliberately left
  out: feet on the ground do not move, and a breath leaking into them would
  leave a walk cycle that never quite settles.

Plus a **neck**, which exists for the small heads rather than for the look —
head size runs down to 0.92 and at that size a head clears the top of the torso
and floats, and the only reason nobody saw it is that the head used to be sunk
deep enough for even the smallest to reach.

**Per-kid state is now bounded by the cast** rather than by every id a round has
handed out. Ids come from a counter that never goes backwards and Water War
spawns a raid every few seconds. Pruned on "was not drawn this frame" rather
than on a departure hook, because there is no one place a kid leaves from — a
bot goes down inside its mode, a guest drops off a socket, a whole roster is
replaced at the end of a round — and the hook that is eventually forgotten
leaves a ghost nobody notices.

One more of the same kind while the file was open: `pairCapacity` is a helper
written so that "the two places that build a batch cannot disagree", and it was
called by neither — the constructor wrote `capacity * 2` by hand. A helper that
exists to stop two things drifting apart and is used by one of them is not doing
the job it claims to.

---

# 17. Two keys for every control, and every control on the screen

Rebinding existed and quietly did the wrong thing. `setBinding` deleted **every**
code an action had and wrote one, so the pairs the defaults ship — W and the up
arrow, either Shift — collapsed the moment anybody touched the screen. Somebody
who moved forward onto a different letter lost the arrow key as well, silently,
and the only clue was that the arrows stopped working.

The pair is the unit now: an action owns an ordered pair of slots and a rebind
writes into one of them. **It has to be slots rather than a set**, because a
player changing one of a pair is choosing *which one*. The lookup a keydown
consults is derived from the slots rather than kept beside them, on the grounds
that two structures which must agree is a bug waiting for a rebind.

---

# 18. The afternoon gets late, and the lights come on

Every screenshot this game had ever taken was the same flat midday. The premise
is an afternoon in somebody's back garden, and the most evocative thing a game
about a back garden can do is get *late*: the sun drops and swings west across a
round, the shadows stretch, the sky drains to a warm horizon under a deep blue,
and a full-length round ends at dusk.

It is presentation and never anything else. Nothing simulates the time, no mode
reads it, no rule depends on it. That is what makes it cheap.

## What the toon ramp does to a sunset, which is the whole difficulty

This is not a physically-based renderer and it must not be lit like one. The
shading is three hard bands on `dot(N, L)`, so what reads as evening is not a
dimmer sun. It is a **lower** one — which rakes light across vertical faces that
were flat at noon — a warmer key against a cooler fill, and an ambient floor
that comes **up**.

That last one is counter-intuitive and it is the important one. Dim the fill
along with the key and everything in shadow lands in the bottom band together: a
lawn, a fence and a kid all become the same dark shape, and a game about telling
who is who across a garden stops working. So the hemisphere light *gains* as the
sun goes, which is also what really happens — at dusk the sky is the brightest
thing left and it is lighting everything. Measured: key **2.60 → 1.45** while
fill goes **0.50 → 0.95**, and a test holds the ratio above 1.5 at every hour so
the three bands cannot collapse into two.

Two more constraints, both with tests on them. The sun has a floor at twelve
degrees, because a sun on the horizon puts every vertical face edge-on to the
key at once — under a three-band ramp that is not "sunset", it is "the lights
went out". And it swings *round* as well as down: a sun that only sinks keeps
pointing the same way and the shadows merely get longer in a direction the
player already knows, which is half a sunset at best.

## The trap that was waiting

The shadow map is deliberately static — `autoUpdate` is off and it is rebuilt
only when the world changes. Pure profit while the sun is nailed to one spot,
and a bug the moment it is not: the light would go orange and swing west while
every shadow on the lawn went on pointing at midday. Moving the sun invalidates
it in the same breath, rather than in the caller where somebody will one day
forget.

The other half of that is not paying for it sixty times a second. The time is
quantised to a hundredth of an afternoon — finer than anybody can see move, and
coarse enough that a five-minute round rebuilds a 2048² map a hundred times
instead of eighteen thousand.

**Settings → Picture → Time of day** is there because a player who wants the
golden hour for a screenshot should not have to play four minutes of a round to
get it, and because "the light keeps changing" is a thing some people find
distracting. It is the first setting that is a *word* rather than a number or a
yes/no, so the store grew a `CHOICES` table: `load` checked types and not
values, which is enough until a hand-edited blob says `"timeOfDay": "midnight"`,
passes the typeof check, and leaves the game asking for an hour that does not
exist.

**And then the lights come on.** `daylightAt` computed `lampsLit` from the day
it was written and nothing ever read it, so the sky went to dusk over a
neighbourhood where every lamp post was a grey stick. Thirty lights now: three
street lamps over the turning head, the post out front, twenty-four windows
across the houses that face in, a porch light over the player's own front door
and a bulkhead over the back one.

A light is a **tag on a slab**, not a coordinate in a list somewhere else — two
records of one fact drift the moment somebody nudges a post, so the glow is read
off the same array that gets drawn and turned into collision, at the slab's
position, size and rotation. One additive instanced draw with a **count of zero
all afternoon**: an instanced mesh's `count` is a number handed to the draw call,
so off has to mean zero rather than a matrix scaled to nothing. Additive rather
than real point lights, because a falling-off light on a three-band toon ramp
steps across the grass in rings — and because a light in haze should bloom
rather than fade, which is the one thing in this scene that should get *more*
visible as the fog closes in. The lamps warm up over about eighteen seconds into
`LAMP_TIME` rather than appearing between two frames.

They rendered nothing at first while every number said they were on —
`computeBoundingSphere` walks `count`, and the bound was measured while the
lamps were off, so three culled the mesh against a bound around nothing.
Only the picture was wrong. That is why the check photographs the glow **on its
own**: same sky, same fog, same shadows, the lamps the only thing moved, so
every pixel that differs is a lamp. About nineteen thousand pixels brighter and
none darker; 1,166 with the culling bug put back.

**And the evening has something to sound like.** The dusk this branch built was
completely silent, and a sky that goes orange while the soundscape stays at
midday is half an evening — the half you notice with your eyes shut. Crickets
and a hum of traffic three streets away, on the same synthesis the water bed
uses. A cricket is a **trill inside a chirp**: a fast tremolo near twenty a
second whose depth itself waxes and wanes about every two seconds, because one
LFO alone is a buzz — one insect rather than a garden full of them. Under it,
noise through a very low lowpass: no engine, no tyres, nothing you could point
at, just a floor under the silence. Driven by the same number that brings the
lamps up, so it arrives with the light and, like the light, is a function of the
round timer both machines already have. Opened on first use and **closed when it
returns to zero** — an ambient loop is a noise source, two filters and three
oscillators, and an afternoon should not be paying for a night.

---

# 19. Drawing less of the world, and saying so

Started by measuring rather than guessing, and the measurement *was* the
finding: from five viewpoints — facing the house, facing the street, on the
roof, in the back garden, and facing forty metres of empty lawn — the draw calls
and the triangle count came back **identical to the digit** every time. 406
draws, 279,226 triangles, whichever way you turned. Looking at nothing cost
exactly what looking at the whole neighbourhood cost.

Three causes, in order of size.

**Nothing was frustum-culled.** `PropBatch` switched culling off, with a comment
explaining exactly why it had to: instances of one key span the whole yard, so
the bound covers the whole yard, and an object that large is either wholly in
the frustum or wholly behind you. The fix is not to turn culling on with a bad
bound but to make the bound meaningful — instances are grouped into 48m cells,
each cell its own mesh with its own tight bounds, and three.js culls it for
free. Only busy keys are split, because chunking trades triangles for draw calls
and that trade is a loss on a key with six instances.

**The fence was a fifth of the frame.** 675 pickets at 44 triangles each plus an
outline shell at 44 more, on sticks two centimetres thick — because
`chamferedBox` builds the same 24 vertices whether the bevel is a centimetre or
a fraction of a millimetre, and asking for no chamfer got you a chamfered box
with the inset set to nothing. A plain box is 12.

**The cast was drawn when the lawn was empty.** `CharacterBatch.finish` hid
unused slots with a degenerate matrix — which hides them and still *draws* them,
because an `InstancedMesh` submits `count` instances whatever is in them.

| view | before | after |
|---|---|---|
| yard, facing the house | 406 / 279,226 | 113 / 123,545 |
| front, facing the street | 406 / 279,226 | 145 / 110,717 |
| back garden | 406 / 279,226 | 98 / 109,641 |
| on the roof | 412 / 279,706 | 269 / 137,776 |
| facing empty lawn | 423 / 280,586 | 462 / 194,098 |

Draws down 65–76% and triangles down about 56% in the views a player is actually
in. **The last row is the honest cost of chunking** and is stated rather than
hidden: standing outside the fence looking across the whole horizon, every
distant cell is in view at once and it pays 9% more draw calls to save 31% of
the triangles. Both constants were swept — four cell sizes and four thresholds —
and the pair chosen is the one that wins the common case without making that one
bad.

Then a way for anybody to see this for themselves. **Settings → Show
performance** puts fps, frame time, the 1% low, draw calls and triangles in a
corner. The 1% low is the number that matters and the one an average hides: a
game that stutters once a second reads as broken and averages beautifully. Its
refresh gate compared accumulated floats against a threshold exactly, and
15 × (1/60) is 0.24999999999999997 — just under 0.25 — so the cadence slipped a
frame every window. It carries the remainder now instead of zeroing.

## And the screens in front of it

The title screen ran off the bottom of a 720-line window **with no way to
scroll**, which put Settings out of reach entirely. That is invisible to every
kind of test except one that measures the card against the window, which
`scenarios/frontend.mjs` now does. The modes became a grid of cards that say
what each one *is* rather than a list of names, and Settings was grouped into
five titled sections instead of one column of nineteen rows.

---

# 20. The lawn, the cul-de-sac and every horizon

I photographed the lot from seven viewpoints and counted 8-bit colour buckets.
**One colour covered between fifteen and forty-one per cent of every shot.**
`addGround` was a single `PlaneGeometry(400, 400, 1, 1)` in one flat green, and
it is the largest surface in every frame the game draws.

Vertex-coloured ground plus instanced grass clumps, and no image assets — a
texture pipeline for one lawn would be the heaviest thing in the repository.
**The wear is where the game sends people, not decoration:** `wearPoints()` reads
the map's own constants, so moving an objective moves the worn ground with it.

---

# 21. A wall works because it is a wall

Water War's fortification economy did not work, and the tests could not see it
because they measured the right quantity against the wrong thing.

A tap is drained from 3.2m away, and a ring of planks a player would naturally
build sits *inside* that — so kids stood against the outside of a finished wall
and emptied the tap straight through it. Measured over a full afternoon with the
player standing still, the water kept went **61% at a 1.6m ring, 74% at 2.6m and
8.8% at 3.6m**: no curve a player could ever learn.

A line of sight is the cheapest honest fix: a wall works because it is something
solid between a kid and the tap, rather than because of where the nav grid
happened to leave a gap. The first version of that fix was wrong in a way the
control case caught — the ray aimed at the tap's centre, and every source *is* a
solid prop, so it always ended by hitting the tap itself and blocked every kid
on the map from drinking. **An empty lawn with no wall on it kept 66% of its
water**, which is exactly the kind of number a zero-plank control exists to
produce.

---

# 22. Four things only one player could see

The features above were built for one screen and then left there, each with a
line in "Not yet" admitting it. They share a shape: the *rule* was already on
the wire and the *seeing* was not, so every one of them is a broadcast and a
draw call rather than a design.

**Paint.** A tag was clamped, stamped with its sprayer and stored in exactly the
wire format a host wants, and never sent. It is sent now: a client asks, the
host decides. The `by` a client puts on the wire is ignored and replaced with
the id the host already knows for that socket, because otherwise a tag is a
place to write somebody else's name — the same rule the rest of the session
follows, applied to the one system that is allowed to be silly. Caps are applied
on the host's copy rather than trusted from the sprayer, the sprayer is told
about their own mark by the same echo everybody else gets rather than by drawing
it optimistically and then drawing it twice, and a late joiner is replayed the
fences one message at a time. Eight bugs planted on that path; all eight caught.

**The clatter.** A collapse is the loudest thing in this game and the only
warning anybody gets that a fort is coming down, and it played on the machine
that caused it. It is a host broadcast now, with the part count on it, because
the sound scales with how much wood just hit the ground and a guest who is told
only "something fell" gets a different game to the host. It goes through the
same `ears` funnel as everything else, so the caption comes with it for free —
which is the argument for having built the funnel.

**Everybody's water.** The hoses were computed for every fighter and drawn for
one. `ModeRenderer` now takes a list of running streams and packs the droplets
into the front of one instanced mesh, lowering `count` to what it used. That
last clause is the rule this project has now got wrong in four separate
batches: `InstancedMesh.count` is a number handed to the draw call, so parking
an unused matrix at the origin hides it and still pays for it. Six plants, six
caught, two of them exactly that mistake.

**A face in the lobby.** The lobby knew friend codes and names and had never
been told what anybody looks like, so it drew grey circles. The look is three
colours — shirt, skin, hair — carried on `PublicPlayer` and validated on
arrival, because a colour off a socket is not a colour until something checks
it: `cleanLook` coerces nothing, clamps everything to a value a screen can show,
and falls back per field rather than rejecting the whole message. That last
choice matters more than it looks — a player with a bad hair value should get
default hair, not become invisible. `LOBBY_VERSION` went to 2. Six plants, six
caught, including a colour that was coerced rather than type-checked, which
`Number('red')` had been hiding because NaN fails every check anyway; sending
`null` and `true` — which coerce *successfully* to 0 and 1 — is what caught it.

---

# 23. Two things you tapped a key at

Both of these were the same admission written twice: a list you cycled with a
key, in a game that already had a radial picker for parts and weapons.

**Emotes point rather than cycle.** `main.ts` carried a comment saying so — that
a wheel existed, that this ought to use it, "for now". Paying it off was small,
because `partWheel.ts` never knew what a part was: a `WheelEntry` is a label, a
line of detail and a colour. So this is a **third content set on one wheel**
rather than a second wheel, and the gesture somebody already learned for parts
is the gesture for this.

The care goes into a shared wheel remembering which content it is showing. The
key that closes it must be the key that opened it, or releasing the part key
while the emote wheel is up sends an emote and holding both leaves one stuck
open. The browser plant that proved the check works landed on exactly that.
Three tables describe one emote — its word, its colour, its place in the order —
and they are only correct together; TypeScript catches a missing `Record` entry
and cannot catch a short `EMOTE_ORDER`, because an array of a union is perfectly
happy to be missing a member. Five plants, five caught.

**Blueprints get a screen.** `BlueprintStore` has had `save(name, parts, id)`
and `remove(id)` since it was written and nothing ever called either with
intent: renaming and deleting existed in the model and in no interface, and
choosing one meant tapping a key until the right name went past — fine with
three, useless with ten, and ten is what somebody who saves their own builds
ends up with.

A row per blueprint, priced on the same line as its name, because choosing
between two of them is choosing between two costs as much as two shapes.
"Holding nothing" first and always, because putting the blueprint away is what
is wanted most often and it should not sit at the bottom of a list that grows.
Renaming turns the row into a field rather than opening a dialog. The ones that
ship with the game keep their names and cannot be thrown away, so the two
buttons that would fail are not offered rather than offered and refused. A
rename goes through `save` with the id, which is what makes it a rename rather
than a second blueprint — so one renamed while you are holding it stays in your
hand — and deleting the one in your hand empties the hand, or the preview goes
on drawing a shape that cannot be stamped.

**The scenario presses the buttons rather than calling the callbacks**, and that
distinction is the whole reason this entry is worth reading. Calling them was
the first version: it is the shape this project normally wants — drive what the
player drives — and here it proves nothing, because the callbacks are shared
with the store. A screen wired to nothing would have passed. So would one that
acted and never redrew, which is what was actually wrong. Eight plants, seven
caught first time; the eighth needed a better question and is written up in
[`docs/verification.md`](verification.md) as the third instance on this project
of a check that asserts over a collection the bug removes its subject from.

---

## Verification

**1,413 unit tests** across 63 files, and **twenty-eight browser runs** — a
smoke boot plus twenty-seven scenarios. Typecheck, production build and the
benchmark green.

The session is tested against a **loopback pair**: two complete machines in one
process, connected by two queues, exercising joining, prediction, reconciliation,
building, fighting, talking and departure through exactly the code path a real
socket uses. That is worth stating alongside its limit, because this branch found
the limit: a loopback transport is open immediately and has no relay in the
middle, which is why a guest's dropped hello survived every one of those tests
and was caught the first time a scenario stood up a real server.

**Every assertion in this branch was checked by planting the bug and watching it
fail** — and the ones that turned out *not* to fail, along with every red check
that was the test's fault rather than the game's, are written up in
[`docs/verification.md`](verification.md). That record is in the repository
rather than in this description because a description is a moment and this is a
habit.

The full roll of what was planted — a hundred-odd bugs, each introduced on purpose to watch one assertion fail — is in that same file. It is a list that only grows, which is why it lives in the repository.

---

## Cost

Simulation is untouched and nowhere near its budget: the heaviest line in the
benchmark is fifteen bots at **3.4% of a tick**. Rendering is covered in section
19 and is the direction it should be — every view a player is actually in got
cheaper, and the one view that got more expensive is named rather than averaged
away.

The cast got more expensive to draw and it is stated rather than averaged away.
A kid costs what they are *wearing*: **25 draws and 1,680 triangles** with an
ordinary haircut, 23 and 1,592 shaved, 27 and 1,840 with a ponytail, and four
more draws with all four marks painted. Paint costs one draw call per *shape
actually on screen* rather than one per player, which is what makes a palette of
twelve affordable to offer at all, and the whole cast is free on an empty lawn
because `finish` lowers `count` rather than parking unused slots out of sight.

**That last rule is the one this branch got wrong twice** — most recently the
ponytail, zero-scaled on the five hair styles out of eight that have none, and
found by measuring for this paragraph rather than by any test. Two draw calls
and 160 triangles per kid, for no pixels.

**CI is the cost that moved.** The check job ran in about nine minutes for most
of this project's life and now takes about twenty-eight, because
`scenarios/voice.mjs` is five minutes of it on its own, the soak is three more,
and there are now twenty-seven scenarios. `timeout-minutes` went to 45 to match. That is a real bill for a real check, and
it is the only one here that a reviewer should weigh rather than accept.

## Not yet

- **Per-player mute exists in code and in Settings and nowhere a player can
  click.** There is no list of people in a round to mute somebody from; the rule
  and the storage are both there, waiting on a roster screen.
- **A locker outfit follows you into the lobby list as three colours**, which is
  a face and not an outfit. The lobby draws a head, not a kid.
- **Voice needs TURN to work on every network.** STUN gets two ordinary home
  connections to each other; symmetric NAT and many corporate firewalls need a
  relay somebody runs and pays for. Named rather than hidden — it is the same
  deploy decision this project has now declined three times.
- **A speaking player is marked with a glyph and never a name**, because a guest
  is told other guests' names on a chat line and nowhere else, so the roster to
  caption it with does not exist on their machine.
- **Paint is marks rather than a canvas**, and the reasons are in section 9:
  per-instance texturing means an atlas, a patched shader and UVs on geometry
  that has none, and a 16×16 design on a half-metre chest is four pixels at the
  distance a round is played at. If it ever becomes a bitmap, the record it is
  stored in already has room for one.
- **Nothing in the Locker is earned.** Every colour, shape and slider is
  available from the first launch. A party game with kids in it probably wants
  some of it to be a reward, and that is a progression system, which is a
  decision rather than an omission.
- **The time of day is not on the wire.** A guest who joins four minutes into a
  round gets four minutes of afternoon of their own rather than arriving at dusk
  with everybody else. Nothing depends on it and nobody can be disadvantaged by
  it; putting it on the wire would be traffic spent on a gradient.
- Tag runs one It. The state is a set rather than a field, so a round that
  escalates is a scheduling change and not a rewrite.
- **Support is connectivity, not stress.** A chain of parts back to the ground
  holds any load: nothing sags, buckles, or cares how long a span is or what is
  standing on it. That is a physics simulation; this is a rule about whether
  something is attached to anything.
- **A guest does not hear somebody else's structure fall.** The host decides the
  collapse and sends the removals, and the guest applies them — but the sound is
  played on the machine that asked for the removal. Plumbing an audio event
  through the session is a small job nobody has done.
- **Nobody else sees your spray tags.** Local only, and the one gap that
  matters for a feature about showing off to friends. The record is already the
  wire format.
- **Captions are for sounds, not for speech.** Chat is already text and voice is
  not transcribed; there is no speech-to-text here and adding one would be a
  model download rather than a feature. What is captioned is the world —
  collapses, building, paint, water.
- Repeat-place and undo are host-only. No lag compensation on throws, and no
  reconnection.
- Four unit tests assert wall-clock performance budgets and can fail on a loaded
  runner. Pre-existing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01JY3AUcPGjaEqV9iVCLLoh3
