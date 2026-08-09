import { describe, expect, it } from 'vitest';
import {
  MUFFLED_CUTOFF,
  OCCLUDED_GAIN,
  OPEN_CUTOFF,
  SPEAK_HOLD,
  SPEAK_OFF,
  SPEAK_ON,
  SignalBudget,
  SpeakingGate,
  VOICE_CLEAR,
  VOICE_RADIUS,
  VoiceMesh,
  shouldOffer,
  transmitting,
  voiceMix,
} from './voiceRules.ts';
import { NEAR_RADIUS } from '../game/comms.ts';

const at = (x: number, z: number, y = 0) => ({ x, y, z });
/** Listener facing -Z, so +X is their right. The game's usual basis. */
const RIGHT = { x: 1, z: 0 };

describe('how loud somebody is', () => {
  it('reaches exactly as far as a typed line does', () => {
    // Not a restatement of the constant: the point is that the two systems
    // agree. A voice that carried further than text would mean hearing somebody
    // you cannot read, and the mismatch is invisible until two players compare
    // notes about a conversation only one of them had.
    expect(VOICE_RADIUS).toBe(NEAR_RADIUS);
  });

  it('is at full volume for anybody standing with you', () => {
    const mix = voiceMix(at(1, 1), at(0, 0), RIGHT.x, RIGHT.z);
    expect(mix.gain).toBeCloseTo(1, 5);
  });

  it('stays at full volume out to the clear radius, and not past it', () => {
    const inside = voiceMix(at(0, -(VOICE_CLEAR - 0.2)), at(0, 0), RIGHT.x, RIGHT.z);
    const outside = voiceMix(at(0, -(VOICE_CLEAR + 2)), at(0, 0), RIGHT.x, RIGHT.z);
    expect(inside.gain).toBeCloseTo(1, 5);
    expect(outside.gain).toBeLessThan(1);
  });

  it('is silent at the edge and beyond it', () => {
    expect(voiceMix(at(0, -VOICE_RADIUS), at(0, 0), RIGHT.x, RIGHT.z).gain).toBe(0);
    expect(voiceMix(at(0, -(VOICE_RADIUS + 40)), at(0, 0), RIGHT.x, RIGHT.z).gain).toBe(0);
  });

  it('falls off gently near the listener and steeply at the edge', () => {
    // Compared across **equal-width** steps, which is the whole assertion. The
    // first version of this test measured a 10%-wide step against a 40%-wide
    // one, so a linear ramp satisfied it too and it could not fail — caught by
    // planting linear and watching it pass.
    const span = VOICE_RADIUS - VOICE_CLEAR;
    const gainAt = (t: number) =>
      voiceMix(at(0, -(VOICE_CLEAR + span * t)), at(0, 0), RIGHT.x, RIGHT.z).gain;
    const nearDrop = gainAt(0) - gainAt(0.2);
    const farDrop = gainAt(0.8) - gainAt(1);
    expect(nearDrop).toBeLessThan(farDrop * 0.5);
  });

  it('is still plainly audible across the width of a garden', () => {
    // The number this curve exists for. Halfway out, a teammate has to be
    // intelligible or proximity chat is a feature you can only use by standing
    // still — which is the one thing nobody does in this game.
    const halfway = VOICE_CLEAR + (VOICE_RADIUS - VOICE_CLEAR) * 0.5;
    expect(voiceMix(at(0, -halfway), at(0, 0), RIGHT.x, RIGHT.z).gain).toBeGreaterThan(0.6);
  });

  it('never brightens or exceeds full volume however close somebody stands', () => {
    const onTopOfYou = voiceMix(at(0, 0), at(0, 0), RIGHT.x, RIGHT.z);
    expect(onTopOfYou.gain).toBeLessThanOrEqual(1);
    expect(onTopOfYou.pan).toBe(0);
  });

  it('counts height as distance, so a voice from the roof is further', () => {
    const level = voiceMix(at(0, -8, 0), at(0, 0, 0), RIGHT.x, RIGHT.z);
    const above = voiceMix(at(0, -8, 9), at(0, 0, 0), RIGHT.x, RIGHT.z);
    expect(above.gain).toBeLessThan(level.gain);
  });
});

describe('which ear it arrives in', () => {
  it('puts somebody on your right in your right ear', () => {
    expect(voiceMix(at(6, 0), at(0, 0), RIGHT.x, RIGHT.z).pan).toBeGreaterThan(0.5);
  });

  it('and somebody on your left in your left', () => {
    expect(voiceMix(at(-6, 0), at(0, 0), RIGHT.x, RIGHT.z).pan).toBeLessThan(-0.5);
  });

  it('centres somebody directly ahead', () => {
    expect(voiceMix(at(0, -6), at(0, 0), RIGHT.x, RIGHT.z).pan).toBeCloseTo(0, 5);
  });

  it('never pans fully into one ear, however far to the side they are', () => {
    // Hard panning is disorienting and makes a voice sound like it is inside
    // the headphone rather than in the world.
    expect(Math.abs(voiceMix(at(200, 0), at(0, 0), RIGHT.x, RIGHT.z, false, 400).pan))
      .toBeLessThan(1);
  });

  it('follows the listener turning round rather than the world', () => {
    // Same speaker, listener facing the other way: the voice swaps ears. This
    // is the assertion that would catch the basis being taken from the world
    // rather than from the camera, which is silent and wrong.
    const facingOneWay = voiceMix(at(6, 0), at(0, 0), 1, 0).pan;
    const facingTheOther = voiceMix(at(6, 0), at(0, 0), -1, 0).pan;
    expect(facingOneWay).toBeGreaterThan(0);
    expect(facingTheOther).toBeLessThan(0);
  });
});

describe('a wall between you', () => {
  it('muffles and quietens rather than silencing', () => {
    const clear = voiceMix(at(0, -8), at(0, 0), RIGHT.x, RIGHT.z, false);
    const through = voiceMix(at(0, -8), at(0, 0), RIGHT.x, RIGHT.z, true);
    expect(through.cutoff).toBe(MUFFLED_CUTOFF);
    expect(through.gain).toBeCloseTo(clear.gain * OCCLUDED_GAIN, 6);
    expect(through.gain).toBeGreaterThan(0);
  });

  it('leaves the filter wide open when there is nothing in the way', () => {
    // Open rather than absent: a filter switched in and out of the path clicks,
    // and one that is always there and swept does not.
    expect(voiceMix(at(0, -3), at(0, 0), RIGHT.x, RIGHT.z, false).cutoff).toBe(OPEN_CUTOFF);
  });

  it('does not resurrect somebody already out of range', () => {
    expect(voiceMix(at(0, -99), at(0, 0), RIGHT.x, RIGHT.z, true).gain).toBe(0);
  });
});

describe('who places the call', () => {
  it('has exactly one end of every pair offering', () => {
    // The whole of the glare problem. Two peers that both offer sit in
    // have-local-offer forever and the call never connects.
    for (const [a, b] of [[0, 1], [1, 4], [3, 9], [2, 7]] as const) {
      expect(shouldOffer(a, b)).not.toBe(shouldOffer(b, a));
    }
  });

  it('lets the lower id dial', () => {
    expect(shouldOffer(0, 3)).toBe(true);
    expect(shouldOffer(3, 0)).toBe(false);
  });
});

describe('keeping the mesh in step with the roster', () => {
  it('dials everybody the first time it sees them', () => {
    const mesh = new VoiceMesh();
    expect(mesh.sync([3, 1, 2])).toEqual({ dial: [1, 2, 3], hangUp: [] });
    expect(mesh.size).toBe(3);
  });

  it('asks for nothing when the roster has not changed', () => {
    const mesh = new VoiceMesh();
    mesh.sync([1, 2]);
    expect(mesh.sync([1, 2])).toEqual({ dial: [], hangUp: [] });
  });

  it('dials a joiner and hangs up on a leaver in the same pass', () => {
    const mesh = new VoiceMesh();
    mesh.sync([1, 2]);
    expect(mesh.sync([2, 5])).toEqual({ dial: [5], hangUp: [1] });
    expect(mesh.has(1)).toBe(false);
    expect(mesh.has(5)).toBe(true);
  });

  it('hangs up on everybody when the roster empties', () => {
    const mesh = new VoiceMesh();
    mesh.sync([1, 2, 3]);
    expect(mesh.sync([])).toEqual({ dial: [], hangUp: [1, 2, 3] });
    expect(mesh.size).toBe(0);
  });

  it('redials somebody it was told to forget', () => {
    // A connection that failed is forgotten rather than hung up, and the next
    // sync has to try again — otherwise one ICE failure means that pair never
    // speaks for the rest of the round.
    const mesh = new VoiceMesh();
    mesh.sync([4]);
    mesh.forget(4);
    expect(mesh.sync([4])).toEqual({ dial: [4], hangUp: [] });
  });
});

describe('deciding somebody is talking', () => {
  const frame = 1 / 60;

  it('lights up as soon as a voice crosses the threshold', () => {
    const gate = new SpeakingGate();
    expect(gate.update(SPEAK_ON + 0.01, frame)).toBe(true);
  });

  it('ignores a room that is merely not silent', () => {
    const gate = new SpeakingGate();
    expect(gate.update(SPEAK_OFF * 0.5, frame)).toBe(false);
  });

  it('rides through the gaps between words', () => {
    // A quarter of a second of near-silence is ordinary speech, not the end of
    // it. Without the hold the indicator blinks off between every word.
    const gate = new SpeakingGate();
    gate.update(SPEAK_ON + 0.02, frame);
    let lit = true;
    for (let t = 0; t < SPEAK_HOLD * 0.7; t += frame) lit = gate.update(0, frame);
    expect(lit).toBe(true);
  });

  it('goes out once the hold runs out', () => {
    const gate = new SpeakingGate();
    gate.update(SPEAK_ON + 0.02, frame);
    let lit = true;
    for (let t = 0; t < SPEAK_HOLD * 1.5; t += frame) lit = gate.update(0, frame);
    expect(lit).toBe(false);
  });

  it('does not strobe on a voice sitting exactly at the threshold', () => {
    // The Schmitt-trigger case, and the reason there are two levels rather than
    // one. A single threshold toggles on every frame here, which reads as a
    // rendering fault rather than as speech.
    const gate = new SpeakingGate();
    gate.update(SPEAK_ON + 0.001, frame);
    let flips = 0;
    let last = true;
    for (let i = 0; i < 60; i++) {
      // Wobbling between the two thresholds, which is what a held vowel does.
      const now = gate.update(i % 2 === 0 ? SPEAK_OFF + 0.001 : SPEAK_ON - 0.001, frame);
      if (now !== last) flips++;
      last = now;
    }
    expect(flips).toBe(0);
  });

  it('starts silent and can be put back', () => {
    const gate = new SpeakingGate();
    expect(gate.speaking).toBe(false);
    gate.update(1, frame);
    expect(gate.speaking).toBe(true);
    gate.reset();
    expect(gate.speaking).toBe(false);
  });
});

describe('how much signalling one person may send', () => {
  it('lets a whole ICE burst through', () => {
    // The reason this is a bucket and not the gap limiter chat uses: twenty
    // candidates arriving inside a second is a healthy connection, not abuse.
    const budget = new SignalBudget();
    for (let i = 0; i < 20; i++) expect(budget.allow(1)).toBe(true);
  });

  it('stops somebody sending without end', () => {
    const budget = new SignalBudget(8, 40);
    let allowed = 0;
    for (let i = 0; i < 500; i++) if (budget.allow(1)) allowed++;
    expect(allowed).toBe(40);
  });

  it('refills over time', () => {
    const budget = new SignalBudget(8, 40);
    while (budget.allow(1)) { /* drain */ }
    budget.tick(1);
    let allowed = 0;
    while (budget.allow(1)) allowed++;
    expect(allowed).toBe(8);
  });

  it('never refills past the burst size', () => {
    const budget = new SignalBudget(8, 40);
    budget.allow(1);
    budget.tick(1000);
    let allowed = 0;
    while (budget.allow(1)) allowed++;
    expect(allowed).toBe(40);
  });

  it('budgets each person separately', () => {
    // One guest flooding must not stop anybody else connecting, which is the
    // whole point — otherwise the limiter is itself the denial of service.
    const budget = new SignalBudget(8, 40);
    while (budget.allow(1)) { /* drain */ }
    expect(budget.allow(2)).toBe(true);
  });

  it('forgets somebody who left, so their id does not keep a debt', () => {
    const budget = new SignalBudget(8, 40);
    while (budget.allow(1)) { /* drain */ }
    budget.forget(1);
    expect(budget.allow(1)).toBe(true);
  });
});

describe('whether this machine is sending', () => {
  it('sends nothing at all when voice is off', () => {
    expect(transmitting(false, false, false, true)).toBe(false);
  });

  it('sends continuously on an open mic', () => {
    expect(transmitting(true, false, false, false)).toBe(true);
  });

  it('sends only while the key is down on push to talk', () => {
    expect(transmitting(true, false, true, false)).toBe(false);
    expect(transmitting(true, false, true, true)).toBe(true);
  });

  it('lets muting yourself beat holding the key', () => {
    // The order matters and is the one that is easy to get backwards: a muted
    // player who holds the key must not transmit, and nobody would notice the
    // bug except the person being heard.
    expect(transmitting(true, true, true, true)).toBe(false);
    expect(transmitting(true, true, false, false)).toBe(false);
  });
});
