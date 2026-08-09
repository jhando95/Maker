/**
 * The order the game does things in, written down as data.
 *
 * Two published arguments meet here and point the same way.
 *
 * Tim Ford's GDC talk on Overwatch's architecture makes the strong version of
 * the claim: systems run in a **fixed, declared order**, each one states what it
 * reads and what it writes, and that ordering is what makes the simulation
 * deterministic enough to network. His retrospective note is the one worth
 * copying — the team spent about eighteen months settling those rules, and the
 * code that predated or broke them stayed the largest source of bugs for the
 * rest of the project. The rules earn their keep by being *checkable*, not by
 * being agreed.
 *
 * Robert Nystrom's argument runs the other way and lands in the same place: an
 * event queue decouples who sends from who receives, and its cost is that all
 * the coupling becomes invisible until run time — you cannot read the order off
 * the source any more. This project has already lost to that shape of problem
 * four times in a milder form, every time two things that had to agree were
 * written down twice.
 *
 * So: no bus, no listeners, no dynamic registration. A list, in order, that says
 * what each step touches. The novel part is the last clause — a stage that reads
 * something nothing before it has written is an ordering bug, and `check` finds
 * it by reading the list rather than by running the game.
 *
 * ## What this replaces
 *
 * Hand-paired instrumentation. The frame had six `profile.start(...)` calls and
 * six matching `stop`s, and only one of the pairs was inside a `try/finally` —
 * with a comment explaining exactly why it had to be. The other five would leave
 * a section open across a frame if anything threw, blanking the readout for the
 * one frame that explains the throw. A runner closes what it opens because it is
 * the only thing that opens it.
 */

/**
 * A name for something a stage touches.
 *
 * Deliberately a free string rather than an enum of every field in the game.
 * The point is not to model the state; it is to say *roughly* what a step needs
 * to have happened before it, at the coarseness a person reasons about — "the
 * wire", "the world", "the camera". A vocabulary fine enough to be exhaustive
 * would be a second copy of the program.
 */
export type Resource = string;

export interface Stage<C> {
  /** Unique within a schedule, and the name its cost is reported under. */
  readonly name: string;
  /** What must already be true when this runs. */
  readonly reads?: readonly Resource[];
  /** What is true afterwards that was not before. */
  readonly writes?: readonly Resource[];
  /**
   * Which measured section this belongs to, when several stages share one.
   *
   * The readout has a fixed handful of sections and the schedule has more
   * stages than that, so a stage can say which bucket it lands in. Left out, it
   * is measured under its own name.
   */
  readonly section?: string;
  /** Skipped entirely when this says so — and then it is not measured either. */
  readonly when?: (ctx: C) => boolean;
  run(ctx: C): void;
}

/** Whatever is keeping time. Matches `FrameProfile` without depending on it. */
export interface Measure {
  start(section: string): void;
  stop(section: string): void;
}

export interface Problem {
  stage: string;
  resource: Resource;
  /** `missing` — nothing writes it. `late` — something does, but afterwards. */
  kind: 'missing' | 'late';
}

export class Schedule<C> {
  readonly stages: readonly Stage<C>[];

  constructor(stages: readonly Stage<C>[]) {
    const seen = new Set<string>();
    for (const stage of stages) {
      // A duplicate name is not a style complaint. Two stages reporting under
      // one name produce a readout that adds their costs together and a
      // `check` result that cannot say which of them is out of order.
      if (seen.has(stage.name)) {
        throw new Error(`schedule: two stages called "${stage.name}"`);
      }
      seen.add(stage.name);
    }
    this.stages = stages;
  }

  get names(): readonly string[] {
    return this.stages.map((s) => s.name);
  }

  /**
   * Run every stage in order, measuring each.
   *
   * The `finally` is the whole point: a stage that throws still closes its
   * section, so the frame that explains a crash is the one frame whose readout
   * survives it. The throw is not swallowed — a schedule is not an error
   * handler, and the loop above it already has one.
   */
  run(ctx: C, measure?: Measure): void {
    for (const stage of this.stages) {
      if (stage.when !== undefined && !stage.when(ctx)) continue;
      const section = stage.section ?? stage.name;
      measure?.start(section);
      try {
        stage.run(ctx);
      } finally {
        measure?.stop(section);
      }
    }
  }

  /**
   * Read the order and report anything that cannot be satisfied by it.
   *
   * This is the mechanised half of the Overwatch rule. A stage that reads the
   * wire before anything has drained it, or reads the world before the tick has
   * moved it, is a bug that exists in the *arrangement* rather than in any one
   * function — which is exactly the kind that survives unit tests, because
   * every part of it is individually correct.
   *
   * Conditional stages count as writers. A stage that only runs while hosting
   * still satisfies a later reader, and refusing to say so would report a
   * problem on every guest.
   */
  check(): Problem[] {
    const problems: Problem[] = [];
    const written = new Set<Resource>();
    const laterWrites = new Set<Resource>();
    for (const stage of this.stages) {
      for (const resource of stage.writes ?? []) laterWrites.add(resource);
    }
    for (const stage of this.stages) {
      for (const resource of stage.reads ?? []) {
        if (written.has(resource)) continue;
        problems.push({
          stage: stage.name,
          resource,
          kind: laterWrites.has(resource) ? 'late' : 'missing',
        });
      }
      for (const resource of stage.writes ?? []) written.add(resource);
    }
    return problems;
  }

  /** The same order with one stage swapped, for a test that needs a variant. */
  replacing(name: string, stage: Stage<C>): Schedule<C> {
    const at = this.stages.findIndex((s) => s.name === name);
    if (at === -1) throw new Error(`schedule: no stage called "${name}"`);
    const next = [...this.stages];
    next[at] = stage;
    return new Schedule(next);
  }
}

/**
 * A stage that reads and writes nothing, for the many that only touch their own
 * state. Saves every call site writing two empty arrays.
 */
export function step<C>(name: string, run: (ctx: C) => void, extra: Partial<Stage<C>> = {}): Stage<C> {
  return { name, run, ...extra };
}
