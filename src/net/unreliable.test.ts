import { describe, it, expect } from 'vitest';
import type { NetMessage } from './protocol.ts';
import { loopbackPair, type Transport } from './transport.ts';
import {
  AWFUL, HOME, PERFECT, POOR, UnreliableLink, unreliablePair, type LinkConditions,
} from './unreliable.ts';

/** A message whose payload is a number, so delivery order is readable. */
const say = (n: number): NetMessage => ({ t: 'say', ch: 'near', m: String(n) });

/** What came out the far end, as the numbers that went in. */
function received(t: Transport): number[] {
  return t.drain().map((m) => Number((m as { m: string }).m));
}

/** A link whose far end is a plain queue, so a test reads what was delivered. */
function link(conditions: LinkConditions, seed: string | number = 'test') {
  const pair = loopbackPair();
  return { link: new UnreliableLink(pair.host, conditions, seed), far: pair.client };
}

describe('a perfect link', () => {
  it('delivers everything, in the order it was sent', () => {
    const { link: l, far } = link(PERFECT);
    for (let i = 0; i < 20; i++) l.send(say(i));
    l.advance(1 / 60);
    expect(received(far)).toEqual([...Array(20).keys()]);
    expect(l.dropped).toBe(0);
    expect(l.reordered).toBe(0);
  });

  it('holds nothing once it has been advanced', () => {
    const { link: l } = link(PERFECT);
    l.send(say(1));
    expect(l.inFlight).toBe(1);
    l.advance(1 / 60);
    expect(l.inFlight).toBe(0);
  });
});

describe('latency', () => {
  it('keeps a message until its time has come', () => {
    const { link: l, far } = link({ ...PERFECT, latency: 0.1 });
    l.send(say(1));
    // Nine sixtieths is 0.15s… but check the boundary properly rather than
    // trusting one number: nothing before 0.1s, and it after.
    for (let i = 0; i < 5; i++) l.advance(1 / 60);
    expect(received(far)).toEqual([]);
    for (let i = 0; i < 2; i++) l.advance(1 / 60);
    expect(received(far)).toEqual([1]);
  });

  it('never applies a delay outside the envelope it was asked for', () => {
    // Jitter far larger than the latency, which is the case where a naive
    // latency+wobble goes negative and schedules a message in the past.
    //
    // Asserted on the applied delay rather than on arrival order, because
    // arrival cannot tell the difference: a due time of zero and a due time of
    // minus four hundred milliseconds both deliver on the next `advance`. The
    // first version of this test checked what came out and could not fail.
    const conditions = { latency: 0.01, jitter: 0.5, loss: 0, duplicate: 0 };
    const { link: l } = link(conditions, 'wild');
    for (let i = 0; i < 300; i++) { l.send(say(i)); l.advance(1 / 60); }
    expect(l.fastest).toBeGreaterThanOrEqual(0);
    expect(l.slowest).toBeLessThanOrEqual(conditions.latency + conditions.jitter);
    // And the envelope was actually explored, or the bounds above are vacuous.
    expect(l.fastest).toBeLessThan(0.001);
    expect(l.slowest).toBeGreaterThan(0.4);
  });

  it('reports the envelope it applied, so a harness can check it got what it asked for', () => {
    const { link: l } = link({ latency: 0.2, jitter: 0, loss: 0, duplicate: 0 });
    for (let i = 0; i < 10; i++) { l.send(say(i)); l.advance(1 / 60); }
    expect(l.fastest).toBeCloseTo(0.2, 6);
    expect(l.slowest).toBeCloseTo(0.2, 6);
  });
});

describe('loss', () => {
  it('drops everything at 1.0 and counts it', () => {
    const { link: l, far } = link({ ...PERFECT, loss: 1 });
    for (let i = 0; i < 30; i++) l.send(say(i));
    l.advance(1);
    expect(received(far)).toEqual([]);
    expect(l.dropped).toBe(30);
    expect(l.delivered).toBe(0);
  });

  it('drops nothing at 0', () => {
    const { link: l, far } = link({ ...PERFECT, loss: 0 });
    for (let i = 0; i < 30; i++) l.send(say(i));
    l.advance(1);
    expect(received(far)).toHaveLength(30);
    expect(l.dropped).toBe(0);
  });

  it('actually loses some at a middling rate, which is the thing a lossy test must prove', () => {
    const { link: l } = link({ ...PERFECT, loss: 0.3 }, 'lossy');
    for (let i = 0; i < 400; i++) l.send(say(i));
    l.advance(1);
    // Wide bounds on purpose: the assertion is that the dial is connected, not
    // that 400 samples of a 0.3 coin land near the mean.
    expect(l.dropped).toBeGreaterThan(60);
    expect(l.dropped).toBeLessThan(240);
    expect(l.dropped + l.delivered).toBe(400);
  });
});

describe('jitter', () => {
  it('reorders messages, and says that it did', () => {
    const { link: l, far } = link({ latency: 0.1, jitter: 0.09, loss: 0, duplicate: 0 }, 'shuffle');
    for (let i = 0; i < 60; i++) l.send(say(i));
    l.advance(1);
    const order = received(far);
    expect(order).toHaveLength(60);
    expect(order).not.toEqual([...Array(60).keys()]);
    expect(l.reordered).toBeGreaterThan(0);
    // Everything still arrives — reordering is not loss.
    expect([...order].sort((a, b) => a - b)).toEqual([...Array(60).keys()]);
  });

  it('never reorders without jitter, so a perfect link is a control', () => {
    const { link: l, far } = link({ latency: 0.2, jitter: 0, loss: 0, duplicate: 0 });
    for (let i = 0; i < 60; i++) l.send(say(i));
    l.advance(1);
    expect(received(far)).toEqual([...Array(60).keys()]);
    expect(l.reordered).toBe(0);
  });

  it('delivers in due order across separate advances, not in send order', () => {
    // One message sent late with a short delay must be able to overtake one
    // sent early with a long one. Driven by two conditions rather than by luck.
    const { link: l, far } = link({ latency: 0.2, jitter: 0, loss: 0, duplicate: 0 });
    l.send(say(1));
    l.setConditions({ latency: 0.01, jitter: 0, loss: 0, duplicate: 0 });
    l.advance(0.02);
    l.send(say(2));
    l.advance(0.02);
    expect(received(far)).toEqual([2]);
    l.advance(0.3);
    expect(received(far)).toEqual([1]);
  });
});

describe('duplication', () => {
  it('sends twice at 1.0', () => {
    const { link: l, far } = link({ ...PERFECT, duplicate: 1 });
    l.send(say(7));
    l.advance(1 / 60);
    expect(received(far)).toEqual([7, 7]);
    expect(l.duplicated).toBe(1);
    expect(l.delivered).toBe(2);
  });

  it('never at 0', () => {
    const { link: l, far } = link({ ...PERFECT, duplicate: 0 });
    for (let i = 0; i < 50; i++) l.send(say(i));
    l.advance(1);
    expect(received(far)).toHaveLength(50);
    expect(l.duplicated).toBe(0);
  });
});

describe('the seed', () => {
  it('makes a run repeat exactly', () => {
    const run = (): number[] => {
      const { link: l, far } = link(AWFUL, 'same');
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        l.send(say(i));
        l.advance(1 / 60);
        out.push(...received(far));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('and a different one produce a different run, or the seed does nothing', () => {
    const run = (seed: string): number[] => {
      const { link: l, far } = link(AWFUL, seed);
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        l.send(say(i));
        l.advance(1 / 60);
        out.push(...received(far));
      }
      return out;
    };
    expect(run('one')).not.toEqual(run('two'));
  });
});

describe('a blackout', () => {
  it('loses everything sent during it, and nothing after', () => {
    const { link: l, far } = link(PERFECT);
    l.blackout(0.5);
    expect(l.blacked).toBe(true);
    for (let i = 0; i < 10; i++) { l.send(say(i)); l.advance(1 / 60); }
    expect(received(far)).toEqual([]);
    expect(l.dropped).toBe(10);

    l.advance(0.5);
    expect(l.blacked).toBe(false);
    l.send(say(99));
    l.advance(1 / 60);
    expect(received(far)).toEqual([99]);
  });

  it('leaves the link open, because silence is not a close', () => {
    const { link: l } = link(PERFECT);
    l.blackout(1);
    expect(l.open).toBe(true);
  });

  it('still delivers what was already in flight when it began', () => {
    // A hole in the network swallows what is sent into it. It does not reach
    // back and take what already made it across.
    const { link: l, far } = link({ ...PERFECT, latency: 0.1 });
    l.send(say(1));
    l.blackout(1);
    l.advance(0.2);
    expect(received(far)).toEqual([1]);
  });
});

describe('closing', () => {
  it('throws away what is still in flight rather than flushing it', () => {
    const { link: l, far } = link({ ...PERFECT, latency: 0.5 });
    l.send(say(1));
    l.send(say(2));
    expect(l.inFlight).toBe(2);
    l.close();
    l.advance(1);
    expect(received(far)).toEqual([]);
    expect(l.dropped).toBe(2);
  });

  it('reports itself shut, and sends nothing after', () => {
    const { link: l } = link(PERFECT);
    l.close();
    expect(l.open).toBe(false);
    l.send(say(1));
    expect(l.sent).toBe(0);
  });
});

describe('a pair', () => {
  it('carries both directions', () => {
    const p = unreliablePair(loopbackPair(), PERFECT, 'pair');
    p.host.send(say(1));
    p.client.send(say(2));
    p.advance(1 / 60);
    // Each end's `drain` reads what the *other* end sent.
    expect(received(p.client)).toEqual([1]);
    expect(received(p.host)).toEqual([2]);
  });

  it('loses different messages in each direction', () => {
    // One generator shared by both would drop the same packet numbers up and
    // down, which no real network does and which would hide any bug whose
    // trigger is a one-way hole.
    const p = unreliablePair(loopbackPair(), POOR, 'both');
    for (let i = 0; i < 500; i++) {
      p.host.send(say(i));
      p.client.send(say(i));
      p.advance(1 / 60);
      received(p.host);
      received(p.client);
    }
    expect(p.host.dropped).toBeGreaterThan(0);
    expect(p.client.dropped).toBeGreaterThan(0);
    expect(p.host.dropped).not.toBe(p.client.dropped);
  });
});

describe('the presets', () => {
  it('are ordered from mild to hostile on every dial', () => {
    // Not decoration: a preset named AWFUL that is gentler than POOR would make
    // every test using it quietly weaker than it reads.
    for (const dial of ['latency', 'jitter', 'loss'] as const) {
      expect(HOME[dial]).toBeGreaterThanOrEqual(PERFECT[dial]);
      expect(POOR[dial]).toBeGreaterThan(HOME[dial]);
      expect(AWFUL[dial]).toBeGreaterThan(POOR[dial]);
    }
  });

  it('leave PERFECT with every dial at zero', () => {
    expect(PERFECT).toEqual({ latency: 0, jitter: 0, loss: 0, duplicate: 0 });
  });
});
