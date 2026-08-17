import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './fake-store.ts';
import {
  FakeDeployer,
  fakeBroker,
  fakeConfigSource,
  fakeTrigger,
  manualClock,
  refusingBroker,
  tickingClock,
} from './fake-deployer.ts';
import { deployEnvironment, type DeployPorts } from '../src/core/deploy.ts';
import { Registry, registryKeyFor } from '../src/core/registry.ts';
import { pullRequestNumberFor } from '../src/core/identity.ts';
import type { DefaultBranchContext, PullRequestContext, TriggerContext } from '../src/core/ports.ts';

const REPO = 'acme/widgets';
const HEAD = 'a1b2c3d4';

const CONFIG = `storage:
  bucket: skyhook-acme
  region: us-east-1
  account: "123456789012"

deploy:
  directory: infrastructure
`;

function context(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    kind: 'pull-request',
    repository: REPO,
    pullRequestNumber: 482,
    headCommit: HEAD,
    fromFork: false,
    ...overrides,
  };
}

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-14T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

interface Harness {
  readonly ports: DeployPorts;
  readonly store: FakeStore;
  readonly registry: Registry;
  readonly deployer: FakeDeployer;
}

function harness(options: {
  store?: FakeStore;
  deployer?: FakeDeployer;
  config?: string | null;
  ctx?: TriggerContext;
  stepMs?: number;
} = {}): Harness {
  const store = options.store ?? new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  const deployer = options.deployer ?? new FakeDeployer();
  const ports: DeployPorts = {
    trigger: fakeTrigger({ ok: true, context: options.ctx ?? context() }),
    configSource: fakeConfigSource(options.config === undefined ? CONFIG : options.config),
    broker: fakeBroker(registry, deployer),
    now: tickingClock(options.stepMs ?? 0),
  };
  return { ports, store, registry, deployer };
}

// --- the ordering that keeps the no-orphans promise --------------------------

test('feat-002/AC-2 the record exists before any infrastructure is applied', async () => {
  // AC-2: a registry record exists before any of the consuming repository's
  // infrastructure is applied. Demonstrated by a deploy whose apply fails outright: the
  // record naming that environment is present afterwards.
  //
  // The observation is taken INSIDE the deploy call, not after it. Asserting afterwards
  // would pass equally well if the two had happened in the other order.
  let keysWhenApplyBegan: readonly string[] = [];
  const store = new FakeStore();
  const deployer = new FakeDeployer({
    onDeploy: () => {
      keysWhenApplyBegan = store.allKeys();
    },
    outcome: {
      ok: false,
      reason: 'consumer-apply-failed',
      problem: 'terraform apply exited 1',
      timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
    },
  });
  const { ports } = harness({ store, deployer });

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'consumer-failed');
  assert.deepEqual(keysWhenApplyBegan, [registryKeyFor(REPO, 'pr-482')]);
  // And it is still there afterwards — a failed apply never removes the record.
  assert.deepEqual(store.allKeys(), [registryKeyFor(REPO, 'pr-482')]);
});

test('feat-002/AC-3 a failed apply leaves the recorded commit alone', async () => {
  // AC-3: the commit recorded against an environment changes only after a successful
  // apply. On a first deploy that means it stays null — the record says, truthfully, that
  // nothing has been deployed here yet.
  const store = new FakeStore();
  const deployer = new FakeDeployer({
    outcome: {
      ok: false,
      reason: 'consumer-apply-failed',
      problem: 'terraform apply exited 1',
      timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
    },
  });
  const { ports, registry } = harness({ store, deployer });

  await deployEnvironment(ports);

  const record = await registry.read(REPO, 'pr-482');
  assert.equal(record.ok && record.record?.deployedCommit, null);
  assert.equal(record.ok && record.record?.url, null);
});

test('feat-002/AC-3 a failed apply leaves a previously recorded commit unchanged', async () => {
  const store = new FakeStore();
  const first = harness({ store });
  await deployEnvironment(first.ports);

  const failing = harness({
    store,
    deployer: new FakeDeployer({
      outcome: {
        ok: false,
        reason: 'consumer-apply-failed',
        problem: 'terraform apply exited 1',
        timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
      },
    }),
    ctx: context({ headCommit: 'newer999' }),
  });
  const result = await deployEnvironment(failing.ports);

  assert.equal(result.kind, 'consumer-failed');
  const record = await failing.registry.read(REPO, 'pr-482');
  assert.equal(record.ok && record.record?.deployedCommit, HEAD);
});

// --- one environment per pull request ----------------------------------------

test('feat-002/AC-4 a second push updates the same record with the new commit', async () => {
  // AC-4: a second push leaves exactly one record for that pull request, with the same
  // identity as before and the newly pushed commit recorded against it.
  const store = new FakeStore();
  await deployEnvironment(harness({ store }).ports);
  const afterFirst = await new Registry(store).read(REPO, 'pr-482');

  const second = harness({ store, ctx: context({ headCommit: 'second22' }) });
  const result = await deployEnvironment(second.ports);

  assert.equal(result.kind, 'deployed');
  assert.deepEqual(store.allKeys(), [registryKeyFor(REPO, 'pr-482')]);
  const afterSecond = await second.registry.read(REPO, 'pr-482');
  assert.equal(afterSecond.ok && afterSecond.record?.deployedCommit, 'second22');
  // Same environment, not a new one wearing the same name.
  assert.equal(
    afterFirst.ok && afterFirst.record?.createdAt,
    afterSecond.ok ? afterSecond.record?.createdAt : 'different',
  );
});

test('feat-002/AC-5 a closed and reopened pull request deploys to the environment it had', async () => {
  // AC-5: a pull request closed and reopened, whose environment has not been torn down,
  // deploys to that same environment. No second record appears.
  //
  // Nothing in THIS feature releases a record — teardown on close is its own feature — so
  // the released state is set up directly here. That is the honest limit of what can be
  // proved until teardown exists, and it is recorded in the spec's sharp edges.
  const store = new FakeStore();
  const setup = harness({ store });
  await deployEnvironment(setup.ports);
  const claimed = await setup.registry.read(REPO, 'pr-482');
  assert.equal(claimed.ok, true);
  if (claimed.ok && claimed.record !== null) {
    await setup.registry.release(REPO, 'pr-482', claimed.version);
  }

  const reopened = harness({ store, ctx: context({ headCommit: 'reopen1' }) });
  const result = await deployEnvironment(reopened.ports);

  assert.equal(result.kind, 'deployed');
  assert.deepEqual(store.allKeys(), [registryKeyFor(REPO, 'pr-482')]);
  const record = await reopened.registry.read(REPO, 'pr-482');
  assert.equal(record.ok && record.record?.state, 'active');
  assert.equal(record.ok && record.record?.deployedCommit, 'reopen1');
});

test('feat-002/AC-6 two pull requests get distinct environments and never touch each other', async () => {
  // AC-6: two pull requests deploying concurrently produce two records with distinct
  // identities and two independent infrastructure copies, and neither run's state is read
  // or written by the other.
  const store = new FakeStore();
  const one = harness({ store, ctx: context({ pullRequestNumber: 1, headCommit: 'aaa' }) });
  const two = harness({ store, ctx: context({ pullRequestNumber: 2, headCommit: 'bbb' }) });

  const [first, second] = await Promise.all([
    deployEnvironment(one.ports),
    deployEnvironment(two.ports),
  ]);

  assert.equal(first.kind, 'deployed');
  assert.equal(second.kind, 'deployed');
  assert.deepEqual(store.allKeys(), [registryKeyFor(REPO, 'pr-1'), registryKeyFor(REPO, 'pr-2')]);
  // Each deployer was asked for its own identity and no other — the environments are
  // separate copies, not one copy deployed twice.
  assert.deepEqual(one.deployer.requests.map((r) => r.identity), ['pr-1']);
  assert.deepEqual(two.deployer.requests.map((r) => r.identity), ['pr-2']);
  const a = await one.registry.read(REPO, 'pr-1');
  const b = await two.registry.read(REPO, 'pr-2');
  assert.equal(a.ok && a.record?.deployedCommit, 'aaa');
  assert.equal(b.ok && b.record?.deployedCommit, 'bbb');
});

// --- the cap ------------------------------------------------------------------

test('feat-002/AC-9 at the cap a new pull request is refused, and nothing is recorded or applied', async () => {
  // AC-9: with the count of active environments at the configured cap, a deploy for a new
  // pull request exits non-zero, names both the cap and the current count, creates no
  // record, and applies nothing.
  const store = new FakeStore();
  for (const n of [1, 2]) store.seed(registryKeyFor(REPO, `pr-${n}`), '{}');
  const before = store.allKeys();

  const { ports, deployer } = harness({
    store,
    config: `${CONFIG}
environment_cap:
  limit: 2
`,
  });
  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.message.includes('2 environments recorded'), true);
  assert.equal(result.kind === 'failed' && result.message.includes('cap 2'), true);
  assert.equal(deployer.called, false);
  assert.deepEqual(store.allKeys(), before);
});

test('feat-002/AC-9 the cap never locks a pull request out of the environment it already holds', async () => {
  // Refreshing is not creating. A pull request at the cap that already has an environment
  // is not adding one, and refusing it would strand a review behind a limit it is not
  // contributing to.
  const store = new FakeStore();
  const capped = `${CONFIG}
environment_cap:
  limit: 2
`;
  await deployEnvironment(harness({ store, config: capped }).ports);
  store.seed(registryKeyFor(REPO, 'pr-999'), '{}');

  const again = harness({ store, config: capped, ctx: context({ headCommit: 'again11' }) });
  const result = await deployEnvironment(again.ports);

  assert.equal(result.kind, 'deployed');
  assert.equal(again.deployer.called, true);
});

// --- forks ---------------------------------------------------------------------

test('feat-002/AC-10 a fork pull request completes without deploying and without failing', async () => {
  // AC-10: a pull request from a fork completes without deploying and without failing, and
  // states that fork pull requests get no environment.
  const store = new FakeStore();
  const { ports, deployer } = harness({ store, ctx: context({ fromFork: true }) });

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'skipped');
  assert.equal(result.kind === 'skipped' && result.message.includes('fork'), true);
  assert.equal(deployer.called, false);
  assert.deepEqual(store.allKeys(), []);
});

// --- the deploy role, and telling failures apart --------------------------------

test('feat-002/AC-11 an absent deploy role stops the run before anything is applied', async () => {
  // AC-11: when the consuming repository's deploy role is absent, the run exits non-zero
  // before applying anything and names both what is missing and what the maintainer must
  // do about it.
  const store = new FakeStore();
  const deployer = new FakeDeployer();
  const registry = new Registry(store, { now: fixedClock() });
  const result = await deployEnvironment({
    trigger: fakeTrigger({ ok: true, context: context() }),
    configSource: fakeConfigSource(CONFIG),
    broker: refusingBroker(
      'deploy-role-unavailable',
      'the deploy role arn:aws:iam::123456789012:role/skyhook-deploy could not be assumed',
    ),
    now: tickingClock(0),
  });

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.message.includes('skyhook-deploy'), true);
  assert.equal(deployer.called, false);
  assert.deepEqual(store.allKeys(), []);
  assert.equal(registry instanceof Registry, true);
});

test('feat-002/AC-18 a failed apply is reported as the repository\'s, not as skyhook\'s', async () => {
  // AC-18: a run that fails because the consuming repository's apply failed is
  // distinguishable, in its output and its exit status, from a run that failed because
  // skyhook itself could not do its job. Here: two different result kinds, carrying two
  // different sentences.
  const consumer = harness({
    deployer: new FakeDeployer({
      outcome: {
        ok: false,
        reason: 'consumer-apply-failed',
        problem: 'terraform apply exited 1',
        timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
      },
    }),
  });
  const skyhook = harness({
    deployer: new FakeDeployer({
      outcome: {
        ok: false,
        reason: 'skyhook-failed',
        problem: 'the definition may not redirect skyhook state',
        timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
      },
    }),
  });

  const a = await deployEnvironment(consumer.ports);
  const b = await deployEnvironment(skyhook.ports);

  assert.equal(a.kind, 'consumer-failed');
  assert.equal(b.kind, 'failed');
  assert.notEqual(a.kind, b.kind);
});

// --- what comes back -------------------------------------------------------------

test('feat-002/AC-13 the environment address is recorded against its registry record', async () => {
  // AC-13: the URL is recorded against the record, so a later reader can learn where an
  // environment is without redeploying it.
  const { ports, registry } = harness();

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'deployed');
  assert.equal(result.kind === 'deployed' && result.url, 'https://example.test');
  const record = await registry.read(REPO, 'pr-482');
  assert.equal(record.ok && record.record?.url, 'https://example.test');
});

test('feat-002/AC-13 a definition that declares no address still deploys, and says so', async () => {
  // Skyhook does not validate the repository's Terraform — the spec puts that out of
  // scope — so a missing output is reported, never fatal.
  const { ports, registry } = harness({
    deployer: new FakeDeployer({
      outcome: {
        ok: true,
        url: null,
        outputs: { document: {}, omittedSensitive: [] },
        timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
      },
    }),
  });

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'deployed');
  assert.equal(result.kind === 'deployed' && result.url, null);
  assert.equal(
    result.kind === 'deployed' && result.notes.some((n) => n.includes('"url"')),
    true,
  );
  const record = await registry.read(REPO, 'pr-482');
  assert.equal(record.ok && record.record?.url, null);
});

test("feat-002/AC-14 skyhook's own share excludes both of the repository's steps", async () => {
  // AC-14: the run reports how long skyhook's own share took — deriving the identity,
  // claiming, SELECTING THE ENVIRONMENT'S COPY, recording, and reporting. TWO things are
  // excluded and both are the repository's: applying its infrastructure, and the step that
  // prepares that definition beforehand.
  //
  // The whole run takes 13,340ms of wall time. Of that, 5,000 is the consuming repo's apply
  // and 8,000 is terraform preparing its definition — neither of them skyhook's — while 300
  // is selecting this environment's copy, which happens inside the deployer but belongs to
  // skyhook because the criterion names it. So the answer must be 340: both of the
  // repository's steps come off, the preparation does not, and neither does the 40ms
  // skyhook spends around the outside.
  //
  // This test is handed its split rather than computing one, so it can only prove the use
  // case subtracts the right FIELDS. Where the deployer actually draws the boundary is
  // `tests/deploy-adapters.test.ts` — the gap between those two is how `gap-001` lived
  // behind a green suite.
  const clock = manualClock();
  const deployer = new FakeDeployer({
    onDeploy: () => clock.advance(300 + 8_000 + 5_000),
    outcome: {
      ok: true,
      url: 'https://example.test',
      outputs: { document: { url: 'https://example.test' }, omittedSensitive: [] },
      timing: { preparationMs: 300, initMs: 8_000, applyMs: 5_000 },
    },
  });
  const store = new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  // Skyhook's own work outside the deployer, spent inside the run so it is measured.
  const trigger = {
    read: async () => {
      clock.advance(40);
      return { ok: true as const, context: context() };
    },
  };

  const result = await deployEnvironment({
    trigger,
    configSource: fakeConfigSource(CONFIG),
    broker: fakeBroker(registry, deployer),
    now: () => clock.now(),
  });

  assert.equal(result.kind, 'deployed');
  if (result.kind !== 'deployed') return;
  assert.equal(result.skyhookMs, 340);
  assert.ok(result.skyhookMs < 60_000, "skyhook's own share must stay inside its 60-second budget");
});

// --- configuration ---------------------------------------------------------------

test('feat-002/AC-16 a deploy names the settings it is missing rather than guessing', async () => {
  const { ports, deployer, store } = harness({
    config: `storage:
  bucket: skyhook-acme
  region: us-east-1
`,
  });

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.message.includes('storage.account'), true);
  assert.equal(result.kind === 'failed' && result.message.includes('deploy.directory'), true);
  // And it says where to put them, because the default branch is the only place that works.
  assert.equal(result.kind === 'failed' && result.message.includes('default branch'), true);
  assert.equal(deployer.called, false);
  assert.deepEqual(store.allKeys(), []);
});

test('feat-002/AC-12 the deployer is told the identity and the directory, and no variables', async () => {
  // AC-12: the environment identity reaches the definition without skyhook supplying an
  // input variable. What the use case hands down is the identity and where to run — the
  // mechanism by which the definition reads it is the adapter's business, and there is no
  // variable anywhere in this contract to supply.
  const { ports, deployer } = harness();

  await deployEnvironment(ports);

  assert.deepEqual(deployer.requests, [
    { repository: REPO, identity: 'pr-482', directory: 'infrastructure' },
  ]);
});

// --- long-running environments (feat-006) ---------------------------------------

function staging(overrides: Partial<DefaultBranchContext> = {}): DefaultBranchContext {
  return {
    kind: 'default-branch',
    repository: REPO,
    headCommit: HEAD,
    requestedIdentity: 'staging',
    ...overrides,
  };
}

test('feat-006/AC-1 a default-branch deploy records the chosen name before applying, bound to no pull request', async () => {
  // The observation is taken INSIDE the deploy call, exactly as the pull-request ordering
  // test does: the record precedes the resource whatever kind of environment it is.
  let keysWhenApplyBegan: readonly string[] = [];
  const store = new FakeStore();
  const deployer = new FakeDeployer({
    onDeploy: () => {
      keysWhenApplyBegan = store.allKeys();
    },
  });
  const { ports, registry } = harness({ store, deployer, ctx: staging() });

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'deployed');
  assert.equal(result.kind === 'deployed' && result.identity, 'staging');
  assert.equal(result.kind === 'deployed' && result.url, 'https://example.test');
  assert.deepEqual(keysWhenApplyBegan, [registryKeyFor(REPO, 'staging')]);

  const read = await registry.read(REPO, 'staging');
  assert.equal(read.ok && read.record?.deployedCommit, HEAD);
  assert.equal(read.ok && read.record?.url, 'https://example.test');
  // Bound to no pull request: the identity is the only binding a record has, and this one
  // names no pull request.
  assert.equal(pullRequestNumberFor('staging'), null);
});

test('feat-006/AC-2 a second default-branch deploy of the same name updates it in place', async () => {
  const store = new FakeStore();
  await deployEnvironment(harness({ store, ctx: staging() }).ports);

  const second = harness({ store, ctx: staging({ headCommit: 'e5f6a7b8' }) });
  const result = await deployEnvironment(second.ports);

  assert.equal(result.kind, 'deployed');
  // Exactly one record for the name.
  assert.deepEqual(store.allKeys(), [registryKeyFor(REPO, 'staging')]);
  const read = await second.registry.read(REPO, 'staging');
  assert.equal(read.ok && read.record?.deployedCommit, 'e5f6a7b8');
});

test('feat-006/AC-2 a failed apply leaves the previously recorded commit unchanged', async () => {
  const store = new FakeStore();
  await deployEnvironment(harness({ store, ctx: staging() }).ports);

  const failing = harness({
    store,
    ctx: staging({ headCommit: 'brokenbad' }),
    deployer: new FakeDeployer({
      outcome: {
        ok: false,
        reason: 'consumer-apply-failed',
        problem: 'terraform apply exited 1',
        timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
      },
    }),
  });
  const result = await deployEnvironment(failing.ports);

  assert.equal(result.kind, 'consumer-failed');
  const read = await failing.registry.read(REPO, 'staging');
  assert.equal(read.ok && read.record?.deployedCommit, HEAD);
});

test('feat-006/AC-3 a chosen name in the ephemeral namespace is refused before recording or applying', async () => {
  const store = new FakeStore();
  const { ports, deployer } = harness({ store, ctx: staging({ requestedIdentity: 'pr-7' }) });

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.message.includes('ephemeral namespace'), true);
  assert.equal(result.kind === 'failed' && result.message.includes('pr-'), true);
  assert.equal(deployer.called, false);
  assert.deepEqual(store.allKeys(), []);
});

test('feat-006/AC-7 a released long-running record refuses the name as awaiting teardown', async () => {
  // A `released` record is a started manual teardown; the next sweep pass completes it.
  // Reviving it — the pull-request reopen semantic — would race that completion.
  const store = new FakeStore();
  const { registry } = harness({ store });
  const claimed = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.ok(claimed.ok);
  await registry.release(REPO, 'staging', claimed.version);

  const { ports, deployer } = harness({ store, ctx: staging() });
  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.message.includes('awaiting teardown'), true);
  assert.equal(deployer.called, false);
  const read = await harness({ store }).registry.read(REPO, 'staging');
  assert.equal(read.ok && read.record?.state, 'released');
});

test('feat-006/AC-9 a default-branch push updates a protected environment in place, mark untouched', async () => {
  // Protection guards destruction only. An update is not destruction, and the deploy
  // neither reads nor writes the mark.
  const store = new FakeStore();
  const first = harness({ store, ctx: staging() });
  await deployEnvironment(first.ports);
  await first.registry.setProtected(REPO, 'staging', true);

  const second = harness({ store, ctx: staging({ headCommit: 'e5f6a7b8' }) });
  const result = await deployEnvironment(second.ports);

  assert.equal(result.kind, 'deployed');
  assert.deepEqual(await second.registry.isProtected(REPO, 'staging'), { ok: true, isProtected: true });
  const read = await second.registry.read(REPO, 'staging');
  assert.equal(read.ok && read.record?.deployedCommit, 'e5f6a7b8');
});

test('feat-006/AC-10 environments of both kinds count toward one cap', async () => {
  // At the cap, a deploy of a NEW environment of either kind is refused exactly as the
  // deploy action's cap refusal specifies.
  const store = new FakeStore();
  const capped = `${CONFIG}
environment_cap:
  limit: 2
`;
  store.seed(registryKeyFor(REPO, 'pr-1'), '{}');
  store.seed(registryKeyFor(REPO, 'staging'), '{}');

  // A new long-running name is refused...
  const longRunning = harness({ store, config: capped, ctx: staging({ requestedIdentity: 'demo' }) });
  const refusedLong = await deployEnvironment(longRunning.ports);
  assert.equal(refusedLong.kind, 'failed');
  assert.equal(refusedLong.kind === 'failed' && refusedLong.message.includes('cap 2'), true);
  assert.equal(longRunning.deployer.called, false);

  // ...and so is a new pull-request environment, counting the long-running one.
  const ephemeral = harness({ store, config: capped });
  const refusedEphemeral = await deployEnvironment(ephemeral.ports);
  assert.equal(refusedEphemeral.kind, 'failed');
  assert.equal(refusedEphemeral.kind === 'failed' && refusedEphemeral.message.includes('cap 2'), true);
  assert.equal(ephemeral.deployer.called, false);
});

// --- declared inputs: read, refuse, record (chg-007) --------------------------

const CONFIG_WITH_INPUTS = `${CONFIG}  inputs:
    - image_tag
    - speech_image
`;

function inputSource(values: Record<string, string>): NonNullable<DeployPorts['inputSource']> {
  return {
    read: (name) => values[name],
    address: (name) => `TF_VAR_${name}`,
  };
}

test('feat-002/AC-22 a missing declared input is refused before the claim, naming the variable', async () => {
  let deployed = false;
  const store = new FakeStore();
  const deployer = new FakeDeployer({ onDeploy: () => { deployed = true; } });
  const h = harness({ store, deployer, config: CONFIG_WITH_INPUTS });
  const ports: DeployPorts = { ...h.ports, inputSource: inputSource({ image_tag: 'abc123' }) };

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'failed');
  if (result.kind !== 'failed') return;
  // Names the variable in the tool's own vocabulary — what the workflow must actually set.
  assert.match(result.message, /TF_VAR_speech_image/);
  // No default silently deploys in the value's place: nothing recorded, nothing applied.
  assert.deepEqual(store.allKeys(), [], 'no record was written');
  assert.equal(deployed, false, 'nothing was applied');
});

test('feat-002/AC-22 an empty value is refused; whitespace-only is a value, recorded as supplied', async () => {
  const empty = harness({ config: CONFIG_WITH_INPUTS });
  const refused = await deployEnvironment({
    ...empty.ports,
    inputSource: inputSource({ image_tag: '', speech_image: 'x' }),
  });
  assert.equal(refused.kind, 'failed');
  if (refused.kind === 'failed') assert.match(refused.message, /TF_VAR_image_tag/);

  const spaced = harness({ config: CONFIG_WITH_INPUTS });
  const accepted = await deployEnvironment({
    ...spaced.ports,
    inputSource: inputSource({ image_tag: ' ', speech_image: 'x' }),
  });
  assert.equal(accepted.kind, 'deployed');
  const read = await spaced.registry.read(REPO, 'pr-482');
  assert.ok(read.ok && read.record !== null);
  if (!read.ok || read.record === null) return;
  assert.deepEqual(read.record.deployInputs, { image_tag: ' ', speech_image: 'x' });
});

test('feat-002/AC-22 a value over the store rule is refused where it is supplied', async () => {
  for (const bad of ['x'.repeat(513), 'line\nbreak', 'spoof‮txt.exe']) {
    const h = harness({ config: CONFIG_WITH_INPUTS });
    const result = await deployEnvironment({
      ...h.ports,
      inputSource: inputSource({ image_tag: bad, speech_image: 'ok' }),
    });
    assert.equal(result.kind, 'failed', `refused: ${JSON.stringify(bad.slice(0, 20))}`);
    if (result.kind === 'failed') assert.match(result.message, /TF_VAR_image_tag/);
  }
});

test('feat-002/AC-23 recorded values follow the apply exactly as the commit does', async () => {
  // First deploy lands: values and commit recorded together.
  const store = new FakeStore();
  const first = harness({ store, config: CONFIG_WITH_INPUTS });
  const deployedResult = await deployEnvironment({
    ...first.ports,
    inputSource: inputSource({ image_tag: 'abc123', speech_image: 'ecr/speech:1' }),
  });
  assert.equal(deployedResult.kind, 'deployed');
  const afterFirst = await first.registry.read(REPO, 'pr-482');
  assert.ok(afterFirst.ok && afterFirst.record !== null);
  if (!afterFirst.ok || afterFirst.record === null) return;
  assert.equal(afterFirst.record.deployedCommit, HEAD);
  assert.deepEqual(afterFirst.record.deployInputs, {
    image_tag: 'abc123',
    speech_image: 'ecr/speech:1',
  });

  // Second push fails to apply: BOTH stay what the landed deploy recorded.
  const failing = new FakeDeployer({
    outcome: {
      ok: false,
      reason: 'consumer-apply-failed',
      problem: 'terraform apply exited 1',
      timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
    },
  });
  const second = harness({
    store,
    deployer: failing,
    config: CONFIG_WITH_INPUTS,
    ctx: context({ headCommit: 'ffff9999' }),
  });
  const failedResult = await deployEnvironment({
    ...second.ports,
    inputSource: inputSource({ image_tag: 'ffff9999', speech_image: 'ecr/speech:2' }),
  });
  assert.equal(failedResult.kind, 'consumer-failed');
  const afterFailure = await second.registry.read(REPO, 'pr-482');
  assert.ok(afterFailure.ok && afterFailure.record !== null);
  if (!afterFailure.ok || afterFailure.record === null) return;
  assert.equal(afterFailure.record.deployedCommit, HEAD, 'the commit is untouched');
  assert.deepEqual(
    afterFailure.record.deployInputs,
    { image_tag: 'abc123', speech_image: 'ecr/speech:1' },
    'the values are untouched with it',
  );
});

// --- every output rides the result to the caller (chg-008) --------------------

test('feat-002/AC-24 the deploy result carries the outputs document through untouched', async () => {
  const deployer = new FakeDeployer({
    outcome: {
      ok: true,
      url: 'https://pr-482.example',
      outputs: {
        document: { url: 'https://pr-482.example', web_bucket: 'b', cdn: { id: 'E1' } },
        omittedSensitive: ['db_password'],
      },
      timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
    },
  });
  const { ports } = harness({ deployer });
  const result = await deployEnvironment(ports);
  assert.equal(result.kind, 'deployed');
  if (result.kind !== 'deployed') return;
  assert.deepEqual(result.outputs?.document, {
    url: 'https://pr-482.example',
    web_bucket: 'b',
    cdn: { id: 'E1' },
  });
  assert.deepEqual(result.outputs?.omittedSensitive, ['db_password']);
});

// --- the warm slot pool (feat-007) -------------------------------------------

const POOLED_CONFIG = `${CONFIG}
pool:
  target: 2
`;

/** A claimable warm slot, seeded the way the sweep's builder leaves one. */
async function seedWarmSlot(registry: Registry, identity: string): Promise<void> {
  const claimed = await registry.claim({ repository: REPO, identity, state: 'warm' });
  assert.ok(claimed.ok);
  if (!claimed.ok) throw new Error('unreachable');
  const updated = await registry.update(REPO, identity, claimed.version, {
    deployedCommit: 'warm-build-commit',
    url: `https://${identity}.example.test`,
  });
  assert.ok(updated.ok);
}

function pooledHarness(options: { store?: FakeStore; deployer?: FakeDeployer; ctx?: TriggerContext } = {}): Harness & {
  opened: string[];
  scouted: () => number;
} {
  const store = options.store ?? new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  const deployer = options.deployer ?? new FakeDeployer();
  const opened: string[] = [];
  let scouts = 0;
  const ports: DeployPorts = {
    trigger: fakeTrigger({ ok: true, context: options.ctx ?? context() }),
    configSource: fakeConfigSource(POOLED_CONFIG),
    broker: fakeBroker(registry, deployer, {
      scout: registry,
      onOpen: (request) => opened.push(request.identity),
      onScout: () => {
        scouts += 1;
      },
    }),
    now: tickingClock(0),
  };
  return { ports, store, registry, deployer, opened, scouted: () => scouts };
}

test('feat-002/AC-27 a pooled deploy claims the lowest slot, then narrows to it, then applies', async () => {
  const { ports, registry, deployer, opened } = pooledHarness();
  await seedWarmSlot(ports === undefined ? registry : registry, 'slot-2');
  await seedWarmSlot(registry, 'slot-1');

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'deployed');
  if (result.kind !== 'deployed') return;
  assert.equal(result.identity, 'slot-1', 'the lowest-numbered claimable slot wins');
  assert.equal(result.poolPath, 'warm');
  // The narrowing names the resolved slot — never the derived pr identity (chg-009).
  assert.deepEqual(opened, ['slot-1']);
  assert.equal(deployer.requests[0]?.identity, 'slot-1');

  // feat-007/AC-6: the record shows the PR's commit, the re-read URL, and the claimant;
  // the identity is the one fixed at build time.
  const read = await registry.read(REPO, 'slot-1');
  assert.ok(read.ok && read.record !== null);
  if (read.ok && read.record !== null) {
    assert.equal(read.record.state, 'active');
    assert.equal(read.record.claimant, 482);
    assert.equal(read.record.deployedCommit, HEAD);
    assert.equal(read.record.url, 'https://example.test');
  }
  // No environment was created under the derived identity.
  const derived = await registry.read(REPO, 'pr-482');
  assert.ok(derived.ok && derived.record === null, 'no pr-482 record exists');
});

test('feat-007/AC-13 a push to a pull request that already holds a slot refreshes it', async () => {
  const { ports, registry, deployer, opened } = pooledHarness();
  await seedWarmSlot(registry, 'slot-1');
  await seedWarmSlot(registry, 'slot-2');
  // First deploy claims slot-1; the second push must come back to it.
  const first = await deployEnvironment(ports);
  assert.equal(first.kind, 'deployed');
  const second = await deployEnvironment(ports);
  assert.equal(second.kind, 'deployed');
  if (second.kind !== 'deployed') return;
  assert.equal(second.identity, 'slot-1');
  assert.equal(second.poolPath, 'warm');
  assert.deepEqual(opened, ['slot-1', 'slot-1']);
  assert.equal(deployer.requests.length, 2);
  // At no point do two environments exist for one pull request: slot-2 stays warm,
  // and no pr-482 record was ever created.
  const slot2 = await registry.read(REPO, 'slot-2');
  assert.ok(slot2.ok && slot2.record?.state === 'warm');
  const derived = await registry.read(REPO, 'pr-482');
  assert.ok(derived.ok && derived.record === null);
});

test('feat-007/AC-7 an empty pool falls back to a from-scratch deploy in the same run', async () => {
  const { ports, registry, opened } = pooledHarness();
  // One slot exists but is mid-build: commitless, so not claimable.
  const building = await registry.claim({ repository: REPO, identity: 'slot-1', state: 'warm' });
  assert.ok(building.ok);

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'deployed');
  if (result.kind !== 'deployed') return;
  assert.equal(result.identity, 'pr-482');
  assert.equal(result.poolPath, 'cold');
  assert.deepEqual(opened, ['pr-482']);
  const derived = await registry.read(REPO, 'pr-482');
  assert.ok(derived.ok && derived.record?.state === 'active');
});

test('feat-007/AC-7 the cold fallback is capped exactly as today', async () => {
  const store = new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  // Cap of 2, both taken: one standing long-running environment and one warm slot
  // (warm slots count against the cap by decision, od-3).
  await registry.claim({ repository: REPO, identity: 'staging' });
  await registry.claim({ repository: REPO, identity: 'slot-1', state: 'warm' });
  const deployer = new FakeDeployer();
  const ports: DeployPorts = {
    trigger: fakeTrigger({ ok: true, context: context() }),
    configSource: fakeConfigSource(
      `${POOLED_CONFIG}environment_cap:\n  enabled: true\n  limit: 2\n`,
    ),
    broker: fakeBroker(registry, deployer, { scout: registry }),
    now: tickingClock(0),
  };

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') {
    assert.ok(result.message.includes('cap'), result.message);
  }
  assert.equal(deployer.called, false, 'nothing was applied');
});

test('feat-007/AC-14 a claim that wins and an apply that fails leave the slot held, loudly', async () => {
  const deployer = new FakeDeployer({
    outcome: {
      ok: false,
      reason: 'consumer-apply-failed',
      problem: 'terraform apply exited 1',
      timing: { preparationMs: 0, initMs: 0, applyMs: 0 },
    },
  });
  const { ports, registry } = pooledHarness({ deployer });
  await seedWarmSlot(registry, 'slot-1');

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'consumer-failed');
  if (result.kind !== 'consumer-failed') return;
  assert.equal(result.identity, 'slot-1');
  assert.equal(result.poolPath, 'warm');
  const read = await registry.read(REPO, 'slot-1');
  assert.ok(read.ok && read.record !== null);
  if (read.ok && read.record !== null) {
    assert.equal(read.record.state, 'active');
    assert.equal(read.record.claimant, 482);
    // The build-time commit stands — the failed apply moved nothing.
    assert.equal(read.record.deployedCommit, 'warm-build-commit');
  }
});

test('feat-007/AC-5 a lost race moves to the next claimable slot', async () => {
  // Another pull request takes slot-1 between this run's read and its claim write. The
  // sabotage happens inside the store's commit gate, so the loss is a genuine CAS loss.
  let armed = false;
  const store: FakeStore = new FakeStore({
    beforeCommit: async (key) => {
      if (!armed || !key.endsWith('/slot-1.json')) return;
      armed = false;
      const raw = store.rawValue(key);
      if (raw !== undefined) {
        const record = JSON.parse(raw) as { state: string; claimant: number | null };
        record.state = 'active';
        record.claimant = 999;
        store.seed(key, JSON.stringify(record));
      }
    },
  });
  const { ports, registry } = pooledHarness({ store });
  await seedWarmSlot(registry, 'slot-1');
  await seedWarmSlot(registry, 'slot-2');
  armed = true;

  const result = await deployEnvironment(ports);

  assert.equal(result.kind, 'deployed');
  if (result.kind !== 'deployed') return;
  assert.equal(result.identity, 'slot-2', 'the loser moved on to the next claimable slot');
  const slot1 = await registry.read(REPO, 'slot-1');
  assert.ok(slot1.ok && slot1.record?.claimant === 999, 'the winner keeps slot-1');
});

test('feat-007/AC-1 with pooling off, the scout session is never requested', async () => {
  const { ports, registry, deployer } = harness();
  let scouted = 0;
  const withSpy: DeployPorts = {
    ...ports,
    broker: fakeBroker(registry, deployer, {
      scout: registry,
      onScout: () => {
        scouted += 1;
      },
    }),
  };
  const result = await deployEnvironment(withSpy);
  assert.equal(result.kind, 'deployed');
  if (result.kind === 'deployed') {
    assert.equal(result.identity, 'pr-482');
    assert.equal(result.poolPath, null);
  }
  assert.equal(scouted, 0, 'pooling off: nothing new is ever requested');
});

test('feat-007 pooling enabled without a scout-capable broker fails closed, loudly', async () => {
  const store = new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  const deployer = new FakeDeployer();
  const ports: DeployPorts = {
    trigger: fakeTrigger({ ok: true, context: context() }),
    configSource: fakeConfigSource(POOLED_CONFIG),
    broker: fakeBroker(registry, deployer), // no openScout at all
    now: tickingClock(0),
  };
  const result = await deployEnvironment(ports);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.ok(result.message.includes('pool'), result.message);
  assert.equal(deployer.called, false);
});

test('feat-001/AC-38 an inconclusive collision retries the same slot at most twice more', async () => {
  // A scout registry double whose pool claim keeps colliding inconclusively: the run
  // retries the same slot exactly twice more, then treats it as lost and goes cold.
  const store = new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  await seedWarmSlot(registry, 'slot-1');
  const attempts: string[] = [];
  const contendedScout = new Proxy(registry, {
    get(target, property) {
      if (property === 'poolClaim') {
        return async (_repo: string, identity: string) => {
          attempts.push(identity);
          return { ok: false, reason: 'contended' };
        };
      }
      // Bound to the real registry: its private fields live there, not on the proxy.
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const deployer = new FakeDeployer();
  const opened: string[] = [];
  const ports: DeployPorts = {
    trigger: fakeTrigger({ ok: true, context: context() }),
    configSource: fakeConfigSource(POOLED_CONFIG),
    broker: fakeBroker(registry, deployer, {
      scout: contendedScout,
      onOpen: (request) => opened.push(request.identity),
    }),
    now: tickingClock(0),
  };

  const result = await deployEnvironment(ports);

  assert.deepEqual(attempts, ['slot-1', 'slot-1', 'slot-1'], 'three attempts, same slot');
  assert.equal(result.kind, 'deployed');
  if (result.kind === 'deployed') {
    assert.equal(result.identity, 'pr-482', 'exhausted contention falls back to cold');
    assert.equal(result.poolPath, 'cold');
  }
});
