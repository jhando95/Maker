import { describe, it } from 'vitest';
import { segmentHitsCapsule, PROJECTILE_GRAVITY } from '/home/user/Maker/src/game/projectiles.ts';

describe('probe', () => {
  it('spec claim 1: vertical drop from y=3.2 onto capsule at origin', () => {
    // Reproduce the spec's EXACT stated scenario: balloon falling straight down.
    const DT = 1/60, g = 28;
    let y = 3.2, vy = 0, hits = 0;
    for (let i = 0; i < 200 && y > -1.2; i++) {
      vy -= g*DT;
      const dy = vy*DT;
      const t = segmentHitsCapsule(0, y, 0, 0, dy, 0, 0,0,0, 0.4+0.13, 1.7);
      if (t >= 0) { hits++; break; }
      y += dy;
    }
    console.log(`PURE VERTICAL DROP: hits=${hits}, finalY=${y.toFixed(3)}`);
  });

  it('probe: near-vertical drop (slight horizontal drift)', () => {
    const DT = 1/60, g = 28;
    for (const vx0 of [0, 0.05, 0.5, 2, 5]) {
      let x=-0.0, y = 3.2, vy = 0, vx = vx0; let hits = 0; let firstT = -1;
      for (let i = 0; i < 400 && y > -1.2; i++) {
        vy -= g*DT;
        const dx = vx*DT, dy = vy*DT;
        const t = segmentHitsCapsule(x, y, 0, dx, dy, 0, 0,0,0, 0.4+0.13, 1.7);
        if (t >= 0) { hits++; firstT=t; break; }
        x += dx; y += dy;
      }
      console.log(`  vx=${vx0}: hits=${hits} t=${firstT.toFixed(3)} finalY=${y.toFixed(3)} finalX=${x.toFixed(3)}`);
    }
  });

  it('probe: segment STARTS inside XZ circle, descends into height band', () => {
    // start inside circle horizontally, above the head, moving mostly down
    const r = 0.53, h = 1.7;
    // segment fully inside circle for the whole tick, crossing y=h+r downward
    const t = segmentHitsCapsule(0.1, 2.4, 0.0,  0.02, -0.4, 0.0,  0,0,0, r, h);
    console.log(`  start-inside, descends into band -> t=${t}`);
    // segment inside circle entirely, within band
    const t2 = segmentHitsCapsule(0.1, 1.0, 0.0,  0.02, -0.4, 0.0,  0,0,0, r, h);
    console.log(`  start-inside, already in band  -> t=${t2}`);
    // horizontal segment starting inside, staying inside
    const t3 = segmentHitsCapsule(0.1, 1.0, 0.0,  0.3, 0, 0.0,  0,0,0, r, h);
    console.log(`  start-inside, horizontal short -> t=${t3}`);
  });
});
