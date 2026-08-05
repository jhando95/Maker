import { describe, it, expect } from 'vitest';
import { AudioBus } from './audioBus.ts';

describe('AudioBus.spatial', () => {
  // Listener at the origin facing -Z, so its right vector is +X.
  const RIGHT_X = 1;
  const RIGHT_Z = 0;

  it('pans right for a sound to the right', () => {
    const o = AudioBus.spatial(5, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z);
    expect(o.pan!).toBeGreaterThan(0.5);
  });

  it('pans left for a sound to the left', () => {
    const o = AudioBus.spatial(-5, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z);
    expect(o.pan!).toBeLessThan(-0.5);
  });

  it('stays centred for a sound straight ahead', () => {
    const o = AudioBus.spatial(0, 0, -5, 0, 0, 0, RIGHT_X, RIGHT_Z);
    expect(Math.abs(o.pan!)).toBeLessThan(1e-6);
  });

  it('never pans fully hard, so sounds stay in the world', () => {
    for (const x of [1, 10, 100, -100]) {
      const o = AudioBus.spatial(x, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z);
      expect(Math.abs(o.pan!)).toBeLessThanOrEqual(0.8 + 1e-9);
    }
  });

  it('is loudest at the listener and silent past the limit', () => {
    const near = AudioBus.spatial(0.1, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z, 30);
    const mid = AudioBus.spatial(15, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z, 30);
    const far = AudioBus.spatial(40, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z, 30);
    expect(near.distance!).toBeGreaterThan(mid.distance!);
    expect(mid.distance!).toBeGreaterThan(far.distance!);
    expect(far.distance!).toBe(0);
    expect(near.distance!).toBeLessThanOrEqual(1);
  });

  it('falls off faster than linear, so distant sounds do not stay loud', () => {
    // At the halfway point an inverse-style curve must be below the linear 0.5.
    const half = AudioBus.spatial(15, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z, 30);
    expect(half.distance!).toBeLessThan(0.5);
  });

  it('handles a sound exactly on the listener without dividing by zero', () => {
    const o = AudioBus.spatial(0, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z);
    expect(o.pan).toBe(0);
    expect(o.distance).toBe(1);
    expect(Number.isNaN(o.pan!)).toBe(false);
  });

  it('accounts for vertical distance', () => {
    const level = AudioBus.spatial(3, 0, 0, 0, 0, 0, RIGHT_X, RIGHT_Z, 30);
    const above = AudioBus.spatial(3, 12, 0, 0, 0, 0, RIGHT_X, RIGHT_Z, 30);
    expect(above.distance!).toBeLessThan(level.distance!);
  });
});

describe('AudioBus without a user gesture', () => {
  it('reports not running and swallows play calls', () => {
    const bus = new AudioBus();
    expect(bus.running).toBe(false);
    // Must be a silent no-op, not a throw: gameplay calls this every tick and
    // audio may never be unlocked at all.
    expect(() => bus.play('place')).not.toThrow();
    expect(() => bus.startAmbient()).not.toThrow();
    expect(() => bus.stopAmbient()).not.toThrow();
    expect(bus.voiceCount).toBe(0);
  });

  it('clamps volume settings before any context exists', () => {
    const bus = new AudioBus();
    bus.setMasterVolume(5);
    expect(bus.masterVolume).toBe(1);
    bus.setMasterVolume(-2);
    expect(bus.masterVolume).toBe(0);
    bus.setSfxVolume(0.4);
    expect(bus.sfxVolume).toBeCloseTo(0.4);
  });

  it('tracks the muted flag', () => {
    const bus = new AudioBus();
    bus.setMuted(true);
    expect(bus.muted).toBe(true);
    bus.setMuted(false);
    expect(bus.muted).toBe(false);
  });
});
