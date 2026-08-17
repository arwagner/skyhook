import type {
  DestroyOutcome,
  DestroyRequest,
  EnvironmentDestroyer,
  PullRequestState,
  PullRequestStateOutcome,
  PullRequestStateSource,
  ResidualOutcome,
} from '../src/core/ports.ts';

const DESTROYED: DestroyOutcome = { ok: true };
const EMPTY: ResidualOutcome = { ok: true, empty: true };

export interface FakeDestroyerOptions {
  readonly outcome?: DestroyOutcome;
  readonly residual?: ResidualOutcome;
  /**
   * Called the moment `destroy` is entered — the ordering tests sample the store here,
   * because "release precedes destroy" is a claim about *when*, and only an observation
   * taken at that instant can test it (same discipline as FakeDeployer.onDeploy).
   */
  readonly onDestroy?: (request: DestroyRequest) => void | Promise<void>;
}

export class FakeDestroyer implements EnvironmentDestroyer {
  readonly requests: DestroyRequest[] = [];
  /** Mutable on purpose: a retry test heals the destroyer between passes. */
  outcome: DestroyOutcome;
  residual: ResidualOutcome;
  readonly #onDestroy: FakeDestroyerOptions['onDestroy'];

  constructor(options: FakeDestroyerOptions = {}) {
    this.outcome = options.outcome ?? DESTROYED;
    this.residual = options.residual ?? EMPTY;
    this.#onDestroy = options.onDestroy;
  }

  get called(): boolean {
    return this.requests.length > 0;
  }

  async destroy(request: DestroyRequest): Promise<DestroyOutcome> {
    this.requests.push(request);
    if (this.#onDestroy !== undefined) await this.#onDestroy(request);
    return this.outcome;
  }

  async residualResources(_request: DestroyRequest): Promise<ResidualOutcome> {
    return this.residual;
  }
}

/** A pull-request source answering from a fixed table, recording what it was asked. */
export class FakePullRequests implements PullRequestStateSource {
  readonly asked: number[] = [];
  readonly #states: ReadonlyMap<number, PullRequestState>;

  constructor(states: Readonly<Record<number, PullRequestState>>) {
    this.#states = new Map(Object.entries(states).map(([n, s]) => [Number(n), s]));
  }

  async state(_repository: string, pullRequestNumber: number): Promise<PullRequestStateOutcome> {
    this.asked.push(pullRequestNumber);
    const state = this.#states.get(pullRequestNumber);
    if (state === undefined) {
      return { ok: false, problem: `pull request #${pullRequestNumber} could not be looked up` };
    }
    return { ok: true, state };
  }
}
