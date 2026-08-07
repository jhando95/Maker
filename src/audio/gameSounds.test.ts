import { describe, it, expect } from 'vitest';
import { GameSounds } from './gameSounds.ts';
import { AudioBus, type PlayOptions, type SoundName } from './audioBus.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import type { CameraRig } from '../player/cameraRig.ts';
import type { CharacterController } from '../player/controller.ts';

/** A bus that writes down what it was asked to play instead of playing it. */
class Notebook extends AudioBus {
  readonly heard: Array<{ name: SoundName; options: PlayOptions }> = [];

  override play(name: SoundName, options: PlayOptions = {}): void {
    this.heard.push({ name, options });
  }

  last(): { name: SoundName; options: PlayOptions } {
    return this.heard[this.heard.length - 1]!;
  }
}

const camera = { getMoveBasis: () => ({ rx: 1, rz: 0 }) } as unknown as CameraRig;
const standing = (x = 0, z = 0) => ({ x, y: 0, z }) as unknown as CharacterController;

const make = (): { sounds: GameSounds; bus: Notebook } => {
  const bus = new Notebook();
  return { sounds: new GameSounds(bus, new CollisionWorld()), bus };
};

describe('the sound of a structure coming down', () => {
  it('is not the sound of a plank being taken down', () => {
    // The whole reason it exists. Without it the only feedback for losing a
    // tower is that the tower is not there any more.
    const { sounds, bus } = make();
    sounds.removed(0, 1, 3, camera, standing());
    sounds.collapsed(0, 1, 3, camera, standing(), 6);
    expect(bus.heard.map((h) => h.name)).toEqual(['remove', 'collapse']);
  });

  it('gets louder and lower the more of it fell', () => {
    const { sounds, bus } = make();
    sounds.collapsed(0, 1, 0, camera, standing(), 2);
    const small = bus.last().options;
    sounds.collapsed(0, 1, 0, camera, standing(), 10);
    const big = bus.last().options;

    expect(big.volume!).toBeGreaterThan(small.volume!);
    expect(big.pitch!).toBeLessThan(small.pitch!);
  });

  it('stops growing, so a big enough collapse is not the loudest thing here', () => {
    const { sounds, bus } = make();
    sounds.collapsed(0, 1, 0, camera, standing(), 10);
    const ten = bus.last().options;
    sounds.collapsed(0, 1, 0, camera, standing(), 200);
    const lots = bus.last().options;

    expect(lots.volume).toBe(ten.volume);
    expect(lots.pitch).toBe(ten.pitch);
    expect(lots.volume!).toBeLessThanOrEqual(1);
  });

  it('survives being told a nonsense count rather than shrieking', () => {
    // `parts` comes from a list length and should never be under two, but a
    // clamp costs nothing and an un-clamped pitch multiplier is a sound nobody
    // can be warned about.
    const { sounds, bus } = make();
    sounds.collapsed(0, 1, 0, camera, standing(), 0);
    expect(bus.last().options.volume!).toBeGreaterThan(0);
    expect(bus.last().options.pitch!).toBeGreaterThan(0);
  });

  it('carries twice as far as a plank being nailed down', () => {
    // A plank going up forty metres away is somebody else's business. A tower
    // coming down forty metres away is the only warning the person who built
    // it is going to get.
    const { sounds, bus } = make();
    const far = 40;
    sounds.placed(0, 1, far, camera, standing());
    const placement = bus.last().options.distance!;
    sounds.collapsed(0, 1, far, camera, standing(), 8);
    const collapse = bus.last().options.distance!;

    expect(placement).toBe(0);
    expect(collapse).toBeGreaterThan(0.02);
  });

  it('still comes from where it happened', () => {
    const { sounds, bus } = make();
    sounds.collapsed(10, 1, 0, camera, standing(), 4);
    expect(bus.last().options.pan!).toBeGreaterThan(0.5);
    sounds.collapsed(-10, 1, 0, camera, standing(), 4);
    expect(bus.last().options.pan!).toBeLessThan(-0.5);
  });
});
