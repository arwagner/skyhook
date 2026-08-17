import type {
  AccessBroker,
  AccessOutcome,
  AccessRequest,
  DeployOutcome,
  DeployRequest,
  DeployTiming,
  EnvironmentDeployer,
  TriggerOutcome,
  TriggerSource,
} from '../src/core/ports.ts';
import type { ConfigSource, ConfigFetchOutcome } from '../src/core/config.ts';
import type { Registry } from '../src/core/registry.ts';

const NO_TIME: DeployTiming = { preparationMs: 0, initMs: 0, applyMs: 0 };

export interface FakeDeployerOptions {
  readonly outcome?: DeployOutcome;
  /**
   * Called the moment `deploy` is entered. The ordering tests use it to sample the store,
   * because "the record precedes the resource" is a claim about *when* — and only an
   * observation taken at that instant can test it. Asserting after the fact would pass
   * just as happily if the two had happened the other way round.
   */
  readonly onDeploy?: (request: DeployRequest) => void | Promise<void>;
}

export class FakeDeployer implements EnvironmentDeployer {
  readonly requests: DeployRequest[] = [];
  readonly #outcome: DeployOutcome;
  readonly #onDeploy: FakeDeployerOptions['onDeploy'];

  constructor(options: FakeDeployerOptions = {}) {
    this.#outcome = options.outcome ?? {
      ok: true,
      url: 'https://example.test',
      outputs: { document: { url: 'https://example.test' }, omittedSensitive: [] },
      timing: NO_TIME,
    };
    this.#onDeploy = options.onDeploy;
  }

  get called(): boolean {
    return this.requests.length > 0;
  }

  async deploy(request: DeployRequest): Promise<DeployOutcome> {
    this.requests.push(request);
    if (this.#onDeploy !== undefined) await this.#onDeploy(request);
    return this.#outcome;
  }
}

export function fakeTrigger(outcome: TriggerOutcome): TriggerSource {
  return { read: async () => outcome };
}

export function fakeConfigSource(document: string | null): ConfigSource {
  const fetched: ConfigFetchOutcome = { ok: true, document };
  return { fetch: async () => fetched };
}

export interface FakeBrokerOptions {
  /**
   * The scout session's registry (feat-007). Absent means this broker predates pooling
   * and exposes no `openScout` at all — the fail-closed case core must refuse loudly.
   * Tests pass the same registry to prove the scout path is exercised, or a distinct
   * one to prove which session did what.
   */
  readonly scout?: Registry;
  /** Observes every ordinary open — the narrowing tests read the identity asked for. */
  readonly onOpen?: (request: AccessRequest) => void;
  /** Observes every scout open, so "pooling off never scouts" is assertable. */
  readonly onScout?: () => void;
}

export function fakeBroker(
  registry: Registry,
  deployer: EnvironmentDeployer,
  options: FakeBrokerOptions = {},
): AccessBroker {
  const broker: AccessBroker = {
    open: async (request: AccessRequest): Promise<AccessOutcome> => {
      options.onOpen?.(request);
      return { ok: true, grant: { registry, deployer } };
    },
  };
  if (options.scout !== undefined) {
    const scout = options.scout;
    broker.openScout = async () => {
      options.onScout?.();
      return { ok: true, registry: scout };
    };
  }
  return broker;
}

export function refusingBroker(
  reason: 'skyhook-role-unavailable' | 'deploy-role-unavailable',
  problem: string,
): AccessBroker {
  return { open: async () => ({ ok: false, reason, problem }) };
}

/** A clock that advances a fixed amount per reading, so elapsed time is exact. */
export function tickingClock(stepMs: number): () => number {
  let now = 0;
  return () => {
    const value = now;
    now += stepMs;
    return value;
  };
}

export interface ManualClock {
  readonly now: () => number;
  readonly advance: (milliseconds: number) => void;
}

/**
 * A clock that moves only when a test says so.
 *
 * Needed because the timing criterion is about *wall time minus the apply*, and a fake
 * deployer that returns instantly consumes none. Without a clock the test can advance
 * inside the deploy call, subtracting the apply's reported duration from a run that never
 * spent it yields a negative figure — the test would be measuring the double rather than
 * the accounting.
 */
export function manualClock(): ManualClock {
  let now = 0;
  return {
    now: () => now,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}
