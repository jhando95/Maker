import { describe, it, expect } from 'vitest';
import { GameSounds } from './gameSounds.ts';
import { AudioBus, type PlayOptions, type SoundName } from './audioBus.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import type { CameraRig } from '../player/cameraRig.ts';
import type { CharacterController } from '../player/controller.ts';

/** A bus that writes down what it was asked to play instead of playing it. */
class Notebook extends AudioBus {
  readonly heard: Array<{ name: SoundName; options: PlayOptions }> = [];
  readonly loops: Array<{ kind: string; set: number[]; stopped: boolean }> = [];
  /** Pretend a user gesture has happened, so ambience is allowed to open. */
  awake = true;

  override get running(): boolean {
    return this.awake;
  }

  override openLoop(kind: 'water' | 'evening' = 'water') {
    const record = { kind, set: [] as number[], stopped: false };
    this.loops.push(record);
    return {
      set: (volume: number) => { record.set.push(volume); },
      stop: () => { record.stopped = true; },
    };
  }

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

describe('the garden after the lamps come on', () => {
  it('stays silent all afternoon, and does not even open a loop', () => {
    // An ambient loop is a noise source, two filters and three oscillators.
    // An afternoon should not be paying for a night.
    const { sounds, bus } = make();
    sounds.eveningAmbience(0);
    expect(bus.loops).toHaveLength(0);
    expect(sounds.eveningAt).toBe(0);
  });

  it('comes up with the lamps rather than on a clock of its own', () => {
    const { sounds, bus } = make();
    sounds.eveningAmbience(0.3);
    sounds.eveningAmbience(1);
    expect(bus.loops).toHaveLength(1);
    expect(bus.loops[0]!.kind).toBe('evening');
    const [quiet, loud] = bus.loops[0]!.set;
    expect(loud!).toBeGreaterThan(quiet!);
  });

  it('opens exactly one, however many times it is asked', () => {
    // Called every frame from the render loop, which is the whole reason this
    // is worth a test: a loop opened per frame is a fresh oscillator per frame.
    const { sounds, bus } = make();
    for (let i = 0; i < 200; i++) sounds.eveningAmbience(0.8);
    expect(bus.loops).toHaveLength(1);
  });

  it('closes it again when the afternoon comes back', () => {
    // Which it does: a round ends, the next one starts at noon.
    const { sounds, bus } = make();
    sounds.eveningAmbience(1);
    sounds.eveningAmbience(0);
    expect(bus.loops[0]!.stopped).toBe(true);
    expect(sounds.eveningAt).toBe(0);

    sounds.eveningAmbience(1);
    expect(bus.loops).toHaveLength(2);
  });

  it('is quiet enough to be a bed rather than a sound', () => {
    // The moment anybody notices it *as* a sound it is too loud: this is under
    // a game about shouting at each other across a lawn.
    const { sounds, bus } = make();
    sounds.eveningAmbience(1);
    expect(Math.max(...bus.loops[0]!.set)).toBeLessThan(0.15);
    expect(Math.max(...bus.loops[0]!.set)).toBeGreaterThan(0);
  });

  it('survives a level that has gone strange', () => {
    const { sounds } = make();
    sounds.eveningAmbience(NaN);
    expect(sounds.eveningAt).toBe(0);
    sounds.eveningAmbience(9);
    expect(sounds.eveningAt).toBe(1);
  });
});
