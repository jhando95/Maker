# Maker

A cel-shaded backyard building game. You get a pile of lumber and a lawn, and
you nail together whatever you want — ladders, staircases, towers, forts,
bridges. The long-term goal is party modes played *inside* the things you build:
capture the flag, water balloon battles, tag.

A house at the head of a cul-de-sac, with neighbours, hedgerows and woods
filling every horizon it can see, the movement and building mechanics the whole
game rests on, and five modes: **The Floor Is Lava** round the whole garden,
**Capture the Flag** across the two yards, **Tag** out on the street, **Water
War** over the paddling pool, the rain barrel and the garden tap, and **Fort
Defense** on the front lawn. Two browsers can share a lawn and play any of them
together, and there is a locker to decide what you turn up looking like.

**The Floor Is Lava is the one the game is named after.** The grass is out of
bounds; you get round the garden on the deck, the crates, the fence rail, the
treehouse and whatever you nail together to bridge the gaps. Every other mode
treats building as something you do to help you fight. This one has no fighting
in it, and building is the only way to move at all.

```bash
npm install
npm run dev      # http://localhost:5173
```

## Controls

| | |
|---|---|
| `WASD` / arrows | move |
| `Space` | jump — and, against a ledge you can reach, haul yourself over it |
| `Shift` | sprint |
| `Ctrl` | crouch (also fine-placement mode while building) |
| `LMB` | place part — hold to keep placing; throw or soak once the fighting starts |
| `RMB` | remove the part under the crosshair |
| `Alt` | free aim — suspend snapping entirely |
| `R` | cycle to the next snap candidate |
| `Q` / `E` | turn the held part 15° |
| `Z` / `X` | tilt / roll |
| `T` | reset rotation |
| `Tab` (hold) | part wheel — flick a direction, let go; picks your water kit during a fight |
| `1`–`8`, scroll | choose a part |
| `Shift` + wheel | change colour |
| `G` | repeat the last step — hold to run a chain |
| `M` / `N` | next blueprint / save what you are looking at |
| `V` | first ⇄ third person |
| `F` | undo |
| `C` (hold) | push to talk |
| `MMB` | ping whatever you are looking at |
| `Enter` / `Y` | say something / say it to your team only |
| `B` | emotes |
| `Esc` | pause |
| `` ` `` | debug overlay |

**Settings → Locker** is where you decide what you look like: skin, eyes, brows
and mouth, eight haircuts in twelve colours, shirt, trousers and shoes, head
size and build on sliders that stay inside the model, and a mark painted on your
chest, back or either sleeve. You are the preview — the kid standing on the lawn
behind the card is the real one, and everything is worn the moment you pick it.
Keep up to twelve outfits and put one back on in a click. In a game with teams
you wear your team's shirt so everybody can tell who is who; the rest is yours
all round.

**Every control has two keys and both are yours.** Settings → Controls lists all
thirty-seven of them in six groups; click either key to change it, `Backspace`
to leave a control on one key, `Esc` to back out. Binding a key something else
already has takes it, and the screen says which control lost it rather than
letting a binding quietly stop working.

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

During a wave, a capture phase or a raid, the mouse throws and soaks instead of
placing parts, so you are never fumbling between two things on one button. The
on-screen hints follow, because half the build keys do nothing while you are
holding a soaker and a player who tries them learns the wrong lesson.

## Playing with other people

Two browsers, one lawn. Start the server, then swap codes with somebody:

```bash
npm run server                 # ws://localhost:8787
```

Then **Play With Friends**, which is the way it is meant to be used: the server
hands you a short code, you swap codes with somebody, and a queue puts you both
in a yard together. **Host a Yard** and **Join a Yard** stay underneath it for
two people on one network who would rather not involve a matchmaker at all.

The one process serves both: a `/lobby` that knows about players, and the relay
on every other path that knows only about sockets. The lobby's only output is a
room name — it gathers people, elects a host and steps back — so a lobby that
fell over could not interrupt a match already running.

**Identity is a friend code, not an account.** Your browser makes a uuid on
first run and the server maps it to a short shareable code; there is no email,
no password and no database beyond the lobby's own memory. It is worth being
plain that this is *not* authentication — a uuid in localStorage is a bearer
credential, and whoever holds it is you. That is affordable only because nothing
of value hangs off it: a code buys a place in somebody's list and a way to be
invited to a game of tag.

A party is the unit the queue moves, and it is **never split** across two
matches — being separated from the friend you queued with is worse than waiting
longer, so the matchmaker overshoots the target rather than taking half a party
to hit it exactly.

The relay carries bytes between browsers and knows nothing about the game — it
never parses a message, so the protocol can change without touching it. It is a
development server: no TLS, no auth, and no rate limiting beyond a frame cap.

**Host-authoritative.** One player's browser runs the simulation and everybody
else follows it. That is a real trade — the host cannot be stopped from cheating,
and closing their tab ends the round — bought for two things worth more right
now: no deploy target to pay for, and no dependence on two CPUs agreeing about a
square root. The determinism tests prove a round replays identically *in one
process*; they say nothing about float portability, and lockstep would depend on
exactly that.

**Guests predict and are corrected.** A guest moves the moment you press a key,
and when a snapshot says where it really was at tick T it puts the body back
there and replays every input since — so a correction moves you by the size of
the error, not the size of the latency. In practice that is under two
centimetres on a good connection, even though the host disagrees on every single
snapshot: it is always at least one tick behind, because it cannot run a command
it has not received yet.

**Everyone else is interpolated, never simulated.** Remote players are drawn 120
milliseconds behind live. That looks less smooth than extrapolating between
packets and is more honest: it is always showing something that really happened,
and the alternative drifts most exactly when the network is worst.

Building goes through the host too. A guest asks, the host decides, and the
answer reaches everybody — which is what stops two people building into the same
space from opposite sides of a wall and ending up with two different worlds. Part
ids are translated per machine, because two stores allocate them independently
and "remove part 7" otherwise means two different planks.

**Every mode is played together.** The host picks what to play and everybody
joins it within a snapshot — the same phase, the same clock, the same score, the
same objectives on the compass, the same result screen at the end. A guest never
runs the rules. It wears a `RemoteMode`, which is a `GameMode` that computes
nothing and answers every question from the last thing the host said, so the HUD
and the renderer go through code that has no idea a network is involved. That
only works because modes have never rendered: they publish state and the
presentation layer reads it, which was written down as the thing that would one
day let a server run a mode headlessly.

The wood is one pile in the corner of the yard that everybody draws from. A
per-player allowance would mean two people building the same fort hit their own
limits at different moments, which is a strange thing to explain and a stranger
thing to play.

**You cannot pause a game other people are playing.** Opening a menu in a session
takes the cursor and the controls and leaves the world running. Freezing the loop
would stop a guest hearing about the round at all, while the host — which has no
idea a menu is open — went on walking their character from the last command it
received.

**Everybody fights, out of a tank of their own.** Every mode used to carry one
`tank`, one `ammo`, one wind-up and one soaked timer, which is the same thing as
saying it had room for one pair of hands. They are keyed by actor now, so a
guest throws, soaks, gets soaked, is sent home and comes back on exactly the
rules the host plays by — and the host slows a soaked guest by the same rule
that slows a soaked host.

Nothing new goes over the wire to make that work. A command already carried a
trigger, a yaw and a pitch; the host read the position and threw the rest away.
Two things do get sent back. The first is each peer's own four personal numbers
— tank, wetness, wind-up, refill — because those are the four a guest's HUD
showed as blank, and the reason was sound: a needle describing somebody else is
not a meter. The answer was to ask the host the question *per peer* rather than
to mirror its own. The second is the balloons in the air, because a guest runs
no projectile simulation at all, so without them the lawn was silent and the
first sign of an incoming throw was being wet.

Kids now aim at whoever is nearest rather than at whoever is hosting. And people
and bots are numbered out of separate ranges, which sounds like bookkeeping and
is not: both allocators started at 1, so with one guest in the yard the guest and
the first kid of the first raid were the same actor id. Nothing threw. The
roster answered with whichever was added first and a player got dragged toward a
bot.

Not yet: repeat-place and undo are host-only, and only your own stream is drawn
— everybody else's hose is computed and published but nothing draws it, which is
a missing draw call rather than a missing rule.

## Wood costs something

In a mode you are handed a pile of lumber — a hundred and twenty planks — and
another thirty-five before each later build phase, capped so hoarding cannot
bank a fort. Parts are priced by size against a plank, so two ways of covering
the same wall cost the same and the budget never argues for one part over
another. Taking your own work down refunds it in full: scarcity should make you
choose *what* to build, never make you afraid to change your mind.

It is not a difficulty knob. Building was free, and free building has exactly
one best play — build the maximum everywhere — which quietly deletes the
decision from the part of the game named after it. What the pile buys, measured
on the real map with the player standing still all afternoon, walling each tap
with a ring of planks stood on edge:

| what was built | planks | water kept |
|---|---|---|
| nothing | 0 | 0% |
| rings 0.50m high — a kid steps over them | 27 | 0% |
| rings 0.75m high, two metres out | 46 | 9% |
| rings 1.25m high, two metres out | 86 | 51% |
| the same rings taken to 2m | 149 | 51% |
| rings 1.25m high built 4.2m out instead | 204 | 20% |

Three things fall out of that. **Building is worth doing** — nothing to
fifty-one per cent is the difference between losing and winning. **A wall pays
from the first course a kid cannot step over**, which is 0.55m, and stops paying
the moment they cannot see the tap over it; the sixty planks between 1.25m and
2m buy nothing at all. And **more wood is not better wood**: rings built further
out cost twice as much and do worse, because what stops a kid is something solid
between them and the water, not a bigger wall further from it.

### The measurement that found a broken rule

That table used to say something different, and the difference was not a tuning
pass. Draining a tap needed nothing but standing within 3.2m of it — and a ring
a player would naturally build sits *inside* that, so kids stood against the
outside of a finished wall and emptied the tap straight through it.

The payoff was therefore a cliff rather than a curve. Swept by height, every
wall up to a metre kept **exactly 0%** and a 1.25m one kept 51%: sixty-five
planks bought literally nothing and the next twenty bought the round, with
nothing on screen to say why. Swept by radius it was worse than arbitrary —
61%, 51%, 74%, 8.8%, 20% at 1.6m, 2.0m, 2.6m, 3.6m and 4.2m — a shape no player
could learn, because it was not really measuring the wall at all.

Kids have to be able to *reach* the water now. It costs one raycast per kid per
tick and it makes a wall work because it is a wall.

The old table also explained the budget in terms of `MANTLE_MAX_HEIGHT`, on the
grounds that a wall is worth building once a kid can no longer scramble over it.
**Nothing in this game implements mantling.** The constant is read by no code at
all; the only vertical traversal is the 0.55m step-up and climbing a ladder. It
had sat there long enough to size a budget and write a design note, which is the
particular danger of a constant that describes a mechanic nobody wrote: it reads
as a decision, so everything downstream trusts it.

Free Build has no budget. It is where you go to just make things.

## Modes

**Capture the Flag.** Your flag is in the left yard, theirs is in the right, and
the house is in between. Take theirs, get it home, three times. Play alternates
between a build phase and a capture phase, and a capture *ends the round* rather
than scoring a point in a continuous one — so what you actually experience is:
lose the flag, watch exactly how they got in, then get forty-five seconds to fix
that. Both sides split into runners who go for the other team's flag and guards
who sit on their own, and the enemy's mix shifts with the score.

You get two kids on your side — enough that it is a team game rather than a
fetch quest with obstacles, few enough that you are still outnumbered and still
have something to do. Shirts are coloured by side, which is not decoration: you
cannot decide who to throw at if you cannot tell who is who.

**Fort Defense.** Build a fort around the stash on the front lawn, then hold five
waves. Between waves you get time to patch whatever failed.

**Water War.** Four raids of neighbourhood kids come for the paddling pool, the
rain barrel and the garden tap. Hold the water until they get bored.

The kids are not the objective — the water is. You cannot clear the lawn:
soaking someone buys you seven seconds of them not draining a tap, and then they
walk back. That single rule is what makes the mode work. Scoring on kills would
have meant bots pathing to a moving player, which defeats the flow-field cache
outright, and it would have made a fort a detour rather than a wall — you would
have won by chasing, and the building would have been decoration.

Because the taps sit at three corners of the lot and you can only stand at one,
the mode is a triage problem. Raids go for whichever tap is fullest, so ignoring
one is punished specifically, and the answer to a tap you cannot reach in time
is something you built there earlier.

The arsenal splits three ways and no weapon wins at every range:

| | reach | best at | costs |
|---|---|---|---|
| **Soaker** | 8.5m | close work — nothing wets faster point blank | 17 L/s |
| **Balloon** | 12.5m | reaching a tap you are not standing at | 12 L a throw |
| **Hose** | 13m | holding one tap all raid, free but tethered to it | nothing |

Water is the ammunition and the score at once. Your tank refills from the same
taps you are defending, so drinking deep to fight costs you the thing you are
fighting for.

Everyone has a wetness meter rather than dying in one hit. Wet clothes soak
faster, so a fight nearly won finishes instead of stalling; drying is quick once
it starts, so breaking off is a real option; and there is a ceiling on how fast
you can be soaked, so being outnumbered is reliably bad rather than instant. The
kids' shirts darken as they soak, which is how you tell the one you have nearly
finished from the one who just arrived.

## The interface

Outlined, not frosted. Everything solid in this world has a hard dark outline
drawn round it by the renderer, so the interface is drawn the same way: hard
borders and hard offset shadows, never a blur. A translucent panel with a
backdrop blur — which is what this was, and what most games ship — reads as a
sheet of glass in front of the game. An outlined card reads as an object made of
the same stuff as the fence, which is the point of a game where the kids built
everything.

Two surfaces, one language. Menus are cardboard with ink text, because a
full-screen menu has nothing behind it worth seeing and can afford to be a sign
somebody made. In-game panels stay dark, because they sit over a sunlit lawn you
still need to see through. The outline, the radii, the type and the motion are
shared; only the fill differs. The first pass kept the menu dark and the outline
simply vanished — #2b201c on #3a2b25 is the same colour twice, and an outline
needs something bright to outline.

Colours are wired to the world's, not chosen beside it. The two teams' scores
are painted in the exact shirt colours the renderer uses, so a number on the
banner and a kid on the lawn are obviously the same fact.

### Characters

Kids are built out of a torso, a head and four limbs rather than a capsule with
a ball on it, and the limbs swing. That is not only prettier — a capsule has no
front, so a bot walking at you and a bot walking away were the same silhouette,
and nothing about a standing kid said whether they were stopped or about to
move. Six instanced draws instead of two, which is nothing.

The stride advances by ground covered rather than by wall-clock, so feet keep
pace with the world instead of skating, and everyone stopped eases back to a
neutral stance rather than freezing mid-step. Joint heights are fractions of the
collision capsule, so the drawing and the thing that collides cannot disagree
about how tall somebody is.

### Aiming a part

The preview is outlined, not just tinted. A translucent fill is only visible
against something a different colour from itself, and the most common thing to
build onto is another plank — so the ghost vanished exactly when it mattered,
lying flat on the surface it was snapping to. Aiming at a deck, you could not
see where the board would land. The edges are drawn on top of everything now, in
the same hard-line language as the rest of the game.

### In your hands

First person was an empty screen with a crosshair, which reads as a floating eye
rather than a kid in a garden. You now hold the plank you are about to place or
the soaker you are about to fire, which also means the tool you have selected is
legible without reading a chip in the corner. It chases the camera rather than
matching it — exact tracking feels welded to your eyes, a little lag reads as
weight — and bobs only while your feet are on the ground.

Three things the HUD now does that it could not:

- **Points at the objectives.** Water War puts three taps at three corners of a
  forty-eight metre lot; until now the only way to find out which was being
  drained was to walk round and look. Off-screen objectives pin to the edge with
  a chevron and a distance. The distance was hidden there at first, which is
  exactly backwards — an objective you can see tells you roughly how far it is
  by how big it looks, and one you cannot see tells you nothing at all.
- **Says when you connect.** Hitting someone and missing them looked identical
  from behind the crosshair, and the only thing that moved was a meter on a body
  forty metres away.
- **Says where you were hit from.** A wetness meter says how much trouble you
  are in and never which way it is, which turns being ambushed into several
  seconds of turning on the spot.

## Towards more than one player

The point of all of this is party modes played with other people, and the game
now knows how to hold them even though nothing brings them yet.

It grew up around one player and a bag of bots, which were different kinds of
thing: a bot is an id, a body and a side, while the player was a bare character
controller the shell happened to own. That costs nothing until a second person
joins, at which point every piece of code that says "the player" has to decide
which one it meant. An **actor** is the smallest thing that makes them the same,
and deliberately carries nothing else — no health, no wetness, no flag, because
those belong to whichever mode invented them. The three kinds of actor differ
only in where their intent comes from: a keyboard, a behaviour tree, or a socket.

A **command** is one tick of a player's will as data — movement, look, and a
bitfield of buttons. Input, the camera basis and the controller used to be one
straight line through the shell, which works for exactly one player on one
machine. Pulling the reading apart from the acting means the thing in between
can be a recording or a network. Movement is stored already rotated into world
space: sending the raw stick would let a server re-derive and so validate it, but
re-deriving means reproducing floating-point camera state, and a replay that has
to reconstruct its own inputs is a replay that drifts.

Then a **replay** test records a round, plays it into a fresh world and hashes
the result, so nondeterminism fails at the commit that causes it rather than as
a desync between two people a month later. That is not hypothetical here:
`Math.random` is banned from world state for this reason, and a purely cosmetic
splash was drawing from the simulation's own RNG until it was caught by hand.

Checked by planting the bug it is meant to catch. A `Math.random` jitter on a
bot's movement fails it immediately; the same call on a state timer at 1e-6 does
not, because it moves nobody far enough to survive the hash's quantum. So it
catches nondeterminism that changes what happens, not nondeterminism that merely
exists — which is the trade that also stops float noise from failing honest runs.

What is left is the transport. The plan is host-authoritative rather than
server-authoritative: one player's browser runs the simulation and the others
are told about it, which needs no deploy target. It is also the honest answer to
the limit above, since determinism here does not prove float portability between
two different CPUs.

## The map

A cul-de-sac with a house at the centre. Left yard is -X, right yard is +X, and
the house stands between them, so the map has two halves before any mode says
so. A fence would have been easier and wrong: a fence is a thing you walk
around, a house is a thing you go over, and going over it is a building problem.

Twelve metres of house in a forty-eight metre lot divided almost nothing —
measured, walking round the front cost a quarter of a metre over the straight
line — so the divide continues out to the boundary as a fence with two gates at
opposite ends. Three routes across: the front gate, the back gate, and the roof.

The climb up is deliberately unfinished. Porch roof at 2.6m, eaves at 5.0m,
treehouse deck at 4.5m with eight metres of air to the house. Every stage is
reachable except the last, and the last is the part you build.

You can climb what you built; you cannot climb the neighbourhood. Any
near-vertical surface is climbable for player-placed parts — nail rungs to a
wall and the game recognises a ladder without being told — but applying that to
the map would mean shimmying up flat stucco onto the roof, which is the one
thing the house exists to prevent. The treehouse ladder is marked climbable
explicitly.

Walk into a near-vertical surface and you climb it, as long as you built it.
There is no ladder object; a ladder you nailed together yourself works exactly
like one that shipped with the game — which is checked now, by building one out
of parts and climbing it.

The rungs are load-bearing, not decoration. A surface is climbable when its
**depth varies** as you go up — rungs stick out and give a near/far/near pattern
as the probe alternately catches a rung and the board behind it, while a flush
wall answers the same distance every time. That is what physically separates a
ladder from a wall, so that is what gets measured, rather than anything about
what a part is called.

The threshold sits under one plank thickness, so boards nailed flat onto a wall
face count — the cheapest improvised ladder there is, and the one a player is
most likely to try first. Sampling is offset from the build grid on purpose: at
the kit's own 0.25m module, samples 0.25m apart would land on every rung or
between every rung and read a perfect ladder as a flat wall.

This started the other way round — any near-vertical thing you built was
climbable — and it is worth saying why that changed. It reads as generous and is
quietly corrosive. A wall you build never stops *you*, so building tall costs
nothing and the choice carries no trade. Worse, the moment a second person is in
the yard, a fort stops working against the only opponent that matters, which is
a problem you would hit on day one of multiplayer and pay much more to fix then.

Known bug, found while checking this and older than it: the treehouse ladder
stalls around 2.65m instead of reaching its 4.5m deck. Measured identical with
and without the handhold rule, so it is not fallout from the change.

## What is here

```
src/
  core/        game loop, input, commands, replay, seeded RNG, math
  physics/     spatial hash, capsule-vs-OBB collision, part store, collision world
  player/      character controller, camera rig
  build/       part kit, snapping, build system, the lumber budget
  net/         wire format, transports, host and guest sessions
  render/      cel shading, procedural geometry, instanced meshes
  world/       neighborhood map, scene, starter structures
  game/        game modes, actors and teams, per-person combat state, bots,
               flow-field navigation, projectiles
  audio/       synthesized sound
  app/         settings, persistence, identity, crash handling
  ui/          design tokens, HUD, menus, radial part picker
server/
  serve.ts     one process: the relay, and the lobby on /lobby
  websocket.ts the parts of RFC 6455 both of them stand on
  relay.ts     carries bytes between browsers; never parses a game message
  lobbyCore.ts friends, parties and the matchmaker, with no socket in sight
  lobby.ts     the socket wiring around it
tools/
  shoot.mjs    headless screenshot + smoke-test harness
  imgdiff.mjs  counts changed pixels between two PNGs
  bench.ts     simulation cost per tick, at 3000 parts
scenarios/     scripted checks driven through the harness
```

```bash
npm test         # 650 unit tests
npm run typecheck
npm run bench    # what a tick costs, as a share of the 16.67ms budget
node tools/shoot.mjs --out shots/x.png   # boot headless, screenshot, fail on any console error
node tools/shoot.mjs --scenario scenarios/gamepad.mjs   # drive a synthetic controller
```

CI runs all of the above on every push. The scenarios exist because some things
cannot be honestly unit-tested: whether a throw inside the render loop actually
produces a crash screen, whether a stick push actually reaches the character
controller, whether a resolution decision actually reaches the drawing buffer,
whether emptying a water tank and refilling it from a paddling pool works once
the mode, the shell and the HUD are wired together, whether a second person in
the world reaches the renderer's instance buffers wearing the right shirt,
whether the HUD can actually point at an objective that is behind you,
whether running out of wood is ever visible to the player rather than just true,
whether somebody who joined over the network is ever actually drawn, whether a
round somebody else is running reaches your banner and your compass, whether the
ground's vertex colours survive the toon shader. Each only happens in a browser,
and each has broken at least once with the unit suite green.

The reverse is worth stating too, because two claims from the lawn pass were
written as scenarios first and then moved out. Grass growing up through the
street is invisible from directly overhead — the blades are edge-on and cover
half a per cent of the frame — and "the lawn is many colours" passes on a
perfectly flat lawn, because ten thousand individually tinted grass clumps put
hundreds of colours on screen by themselves. Both now live in the unit suite,
checked against positions and tone spreads rather than pixels. A browser
assertion that cannot fail is worse than no assertion, and the way to find out
is to take the fix back out and watch.

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

**The seams multiplayer was built on are still the right ones for a server.**
Simulation runs on a fixed timestep with no `Math.random` in anything affecting
world state. Placement is split into intent and application: `place()` returns a
plain JSON-safe record quantized to a millimetre, and `applyPlace()` is the only
thing that mutates the world — the seam a server would authorise against, and
the same records are the save format. Input is split the same way: a mode reads
`input.of(actorId)` and never touches a camera, so the machine firing a balloon
does not have to be the machine the player is sitting at.

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

1. **Play the modes and tune them.** Every number is a first guess that survived
   arithmetic, which is not the same as being fun. Water War's economy is the
   one with a measured target behind it — an unopposed afternoon demands about
   twice the pool, so you have to stop roughly half the draining — and a test
   holds it there, but whether *half* is the right number is a question for a
   human. Fort Defense's bucket loop is less defended than that: 9.5m and a 0.6s
   channel are guesses, and the balance of turtling versus running turns on them.
2. **More construction tools**: blueprints, line-drag fill, an eyedropper, and
   moving a placed part instead of delete-and-replace.
3. **Netcode** — server-authoritative, client prediction, `PlacePart` intents
   replicated. The seams exist for this.
4. **Woods survival**, which wants resource gathering and structural support
   rules the sandbox deliberately does without.

The biggest risk is still not technical. It is that building under time pressure
is *stressful* rather than joyful — that players stop building and just run
around. The three modes make that testable solo, and Water War is the sharpest
test of it: you cannot win by fighting, so if the building is not enjoyable there
is nothing else there. The version that matters is still two humans building
against each other, and that needs netcode.
