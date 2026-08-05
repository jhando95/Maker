import { describe, it, expect } from 'vitest';
import { formatReport, safeContext, type CrashInfo } from './crashHandler.ts';

/**
 * These cover the parts of the crash handler that are pure logic. The parts
 * that build a DOM overlay are checked in a real browser by
 * scenarios/crash.mjs — jsdom would only prove that createElement works, which
 * is not the thing that could plausibly be wrong.
 */

const info: CrashInfo = {
  message: 'boom',
  stack: 'Error: boom\n    at simulate (main.ts:1:1)',
  phase: 'simulation',
  when: '2026-01-01T00:00:00.000Z',
  userAgent: 'test-agent/1.0',
  context: { parts: 412, mode: 'fortDefense' },
};

describe('formatReport', () => {
  it('includes everything a bug report needs', () => {
    const text = formatReport(info);
    for (const needle of ['boom', 'simulation', '2026-01-01', 'test-agent/1.0', 'at simulate']) {
      expect(text).toContain(needle);
    }
  });

  it('renders context as readable JSON rather than [object Object]', () => {
    const text = formatReport(info);
    expect(text).toContain('"parts": 412');
    expect(text).not.toContain('[object Object]');
  });

  it('survives context that JSON cannot represent', () => {
    // A cycle is the realistic case: attaching a live game object by mistake.
    const cyclic: Record<string, unknown> = { name: 'world' };
    cyclic.self = cyclic;

    // The report must still be produced. A throw while formatting the crash
    // report loses the error it exists to preserve.
    const text = formatReport({ ...info, context: { parts: 5, cyclic } });
    expect(text).toContain('boom');
    expect(text).toContain('parts: 5');
    expect(text).toContain('(unserializable)');
  });
});

describe('safeContext', () => {
  it('passes through a working getter', () => {
    expect(safeContext(() => ({ parts: 3 }))).toEqual({ parts: 3 });
  });

  it('reports a throwing getter instead of propagating', () => {
    // The realistic case: the context getter reads the very state that just
    // went wrong, so it is entirely plausible for it to throw too.
    const result = safeContext(() => {
      throw new Error('world is gone');
    });
    expect(result).toEqual({ contextError: 'world is gone' });
  });

  it('handles a getter that throws a non-Error', () => {
    const result = safeContext(() => {
      throw 'just a string';
    });
    expect(result).toEqual({ contextError: 'just a string' });
  });

  it('reads live state at crash time, not at construction time', () => {
    // main.ts builds the getter before the world exists, so it must be called
    // lazily — a getter evaluated eagerly would capture undefined.
    let parts = 0;
    const get = () => ({ parts });
    parts = 91;
    expect(safeContext(get)).toEqual({ parts: 91 });
  });
});
