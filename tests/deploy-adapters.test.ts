import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubTriggerSource } from '../src/adapters/github/event.ts';
import { requestIdToken } from '../src/adapters/github/oidc-token.ts';
import {
  sessionPolicyFor,
  MAX_INLINE_POLICY_LENGTH,
} from '../src/adapters/aws/session-policy.ts';
import { assumeRoleWithWebIdentity } from '../src/adapters/aws/sts.ts';
import { AwsAccessBroker } from '../src/adapters/aws/broker.ts';
import type { SkyhookConfig } from '../src/core/types.ts';
import {
  TerraformEnvironment,
  detectStateHijack,
  verifyBackend,
} from '../src/adapters/terraform/environment.ts';
import type { CommandResult, CommandRunner, RunOptions } from '../src/cli/process.ts';
import type { ListOutcome, Store } from '../src/core/store.ts';

const REPO = 'acme/widgets';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'skyhook-env-'));
}

// --- what GitHub says happened ------------------------------------------------

function triggerEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_PATH: '/tmp/event.json',
    GITHUB_SHA: 'MERGECOMMIT0000',
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pull_request: {
      number: 482,
      head: { sha: 'headsha1234', repo: { full_name: REPO } },
      ...overrides,
    },
  });
}

test('feat-002/AC-10 a pull request from a fork is recognised before any credential is asked for', async () => {
  const source = new GitHubTriggerSource({
    env: triggerEnv(),
    readFile: () => payload({ head: { sha: 'headsha1234', repo: { full_name: 'someone/fork' } } }),
  });

  const outcome = await source.read();

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.context.kind === 'pull-request' && outcome.context.fromFork, true);
});

test('feat-002/AC-10 a head repository that has vanished counts as a fork', async () => {
  // "Cannot tell" must resolve to the restrictive answer: treating it as the same
  // repository would hand credentials to the one case that must never get them.
  const source = new GitHubTriggerSource({
    env: triggerEnv(),
    readFile: () => payload({ head: { sha: 'headsha1234', repo: null } }),
  });

  const outcome = await source.read();
  assert.equal(outcome.ok && outcome.context.kind === 'pull-request' && outcome.context.fromFork, true);
});

test('feat-002/AC-4 the recorded commit is the pull request head, not the merge commit', async () => {
  // GITHUB_SHA on a pull_request event is an ephemeral merge commit that exists in no
  // branch. Recording it would put a commit nobody recognises on a dashboard.
  const source = new GitHubTriggerSource({ env: triggerEnv(), readFile: () => payload() });

  const outcome = await source.read();

  assert.equal(outcome.ok, true);
  const pr = outcome.ok && outcome.context.kind === 'pull-request' ? outcome.context : null;
  assert.equal(pr?.headCommit, 'headsha1234');
  assert.equal(pr?.pullRequestNumber, 482);
  assert.equal(pr?.fromFork, false);
});

// --- push events: the long-running deploy's trigger (feat-006 plan D2) ----------

function pushEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_PATH: '/tmp/event.json',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'pushsha5678',
    SKYHOOK_ENVIRONMENT: 'staging',
    ...overrides,
  };
}

function pushPayload(defaultBranch = 'main'): string {
  return JSON.stringify({ repository: { default_branch: defaultBranch } });
}

test('trigger: a push to the default branch reads as a default-branch deploy of the chosen name', async () => {
  const source = new GitHubTriggerSource({ env: pushEnv(), readFile: () => pushPayload() });

  const outcome = await source.read();

  assert.deepEqual(outcome, {
    ok: true,
    context: {
      kind: 'default-branch',
      repository: REPO,
      headCommit: 'pushsha5678',
      requestedIdentity: 'staging',
    },
  });
});

test('feat-006/AC-6 a push to any other ref is refused, naming the ref the run needs', async () => {
  // A clarity check for the honest caller: the enforcement is the default-branch role's
  // trust, and the cloud would refuse the credentials anyway. The run says which ref it
  // needs rather than failing confusingly (feat-006 spec).
  const source = new GitHubTriggerSource({
    env: pushEnv({ GITHUB_REF: 'refs/heads/feature-x' }),
    readFile: () => pushPayload(),
  });

  const outcome = await source.read();

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.problem.includes('refs/heads/main'), true);
  assert.equal(!outcome.ok && outcome.problem.includes('refs/heads/feature-x'), true);
});

test('trigger: a push with no chosen environment name is refused with the fix named', async () => {
  const source = new GitHubTriggerSource({
    env: pushEnv({ SKYHOOK_ENVIRONMENT: undefined }),
    readFile: () => pushPayload(),
  });

  const outcome = await source.read();

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.problem.includes('SKYHOOK_ENVIRONMENT'), true);
});

test('trigger: pull_request_target is refused by name, not quietly supported', async () => {
  // The constitution forbids it outright: it runs the default branch's workflow WITH
  // credentials against untrusted code.
  const source = new GitHubTriggerSource({
    env: triggerEnv({ GITHUB_EVENT_NAME: 'pull_request_target' }),
    readFile: () => payload(),
  });

  const outcome = await source.read();

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.problem.includes('pull_request_target'), true);
});

// --- the identity token --------------------------------------------------------

test('oidc: a workflow without id-token permission is told exactly that', async () => {
  const outcome = await requestIdToken('sts.amazonaws.com', { env: {} });

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.problem.includes('id-token: write'), true);
});

test('oidc: the audience is requested from the token service and the token returned', async () => {
  const seen: string[] = [];
  const outcome = await requestIdToken('sts.amazonaws.com', {
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/?api-version=2',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    },
    fetch: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ value: 'jwt.jwt.jwt' }), { status: 200 });
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.token, 'jwt.jwt.jwt');
  assert.equal(seen[0]?.includes('audience=sts.amazonaws.com'), true);
});

// --- the narrowing ---------------------------------------------------------------

test('feat-002/AC-19 the narrowing names this environment and exactly one key beyond it', async () => {
  // feat-002/AC-19 — what skyhook ASKS FOR, which is this criterion, as against feat-002/AC-7,
  // which is what the cloud refuses. chg-001 split those two apart and the tests stayed on AC-7,
  // so AC-19 was the only criterion in this feature nothing held. It then went untrue for a day:
  // it claimed the narrowing named this run's keys "and no other" while chg-008 had added one.
  // This test is the thing that would have said so, which is why it now cites AC-19.
  //
  // Also feat-002/AC-7 and feat-001/AC-29: the same document is where the cloud's refusal of
  // every other environment is expressed, and where the constitution's named exception must be
  // permitted a second time.
  const policy = JSON.parse(
    sessionPolicyFor({ bucket: 'skyhook-acme', repository: REPO, identity: 'pr-482' }),
  ) as { Statement: Array<Record<string, unknown>> };

  const allow = policy.Statement.find((s) => s['Sid'] === 'Own');
  assert.deepEqual(allow?.['Resource'], [
    'arn:aws:s3:::skyhook-acme/registry/acme/widgets/pr-482.json',
    'arn:aws:s3:::skyhook-acme/state/acme/widgets/pr-482/*',
  ]);

  // The exception, asserted as a set rather than left implied by the deep-equal below: the
  // narrowing reaches this environment's own two keys, plus one readable key, and nothing else.
  // A third entry here is a widening, and it fails at this line rather than in a live run.
  const reachable = policy.Statement.filter((s) => s['Effect'] === 'Allow' && s['Sid'] !== 'List')
    .flatMap((s) => (Array.isArray(s['Resource']) ? s['Resource'] : [s['Resource']]) as string[]);
  assert.deepEqual(new Set(reachable), new Set([
    'arn:aws:s3:::skyhook-acme/registry/acme/widgets/pr-482.json',
    'arn:aws:s3:::skyhook-acme/state/acme/widgets/pr-482/*',
    'arn:aws:s3:::skyhook-acme/terraform.tfstate',
  ]));

  // Another pull request's environment appears nowhere it could be acted on, and the
  // explicit deny covers everything the allow does not name.
  const rendered = JSON.stringify(policy);
  assert.equal(rendered.includes('pr-483'), false);
  const deny = policy.Statement.find((s) => s['Sid'] === 'NoOthers');
  assert.equal(deny?.['Effect'], 'Deny');

  // feat-001/AC-29 — the deny exempts this environment's own keys plus exactly one more: the
  // default workspace's state, which the infrastructure tool consults before it can be told which
  // environment it is working on (chg-008). Both layers must permit it, which is why this is
  // asserted here as well as on the role policy: a grant the session then denies is no grant.
  // Anything else appearing here is a widening that needs a delta.
  const defaultWorkspace = 'arn:aws:s3:::skyhook-acme/terraform.tfstate';
  assert.deepEqual(deny?.['NotResource'], [
    ...(allow?.['Resource'] as string[]),
    defaultWorkspace,
  ]);

  // And it is exempt for READS only. The write path must not pick it up.
  assert.equal((allow?.['Resource'] as string[]).includes(defaultWorkspace), false);
  const readOnly = policy.Statement.find((s) => s['Sid'] === 'DefaultWorkspace');
  assert.deepEqual(readOnly?.['Action'], ['s3:GetObject']);
  assert.equal(readOnly?.['Resource'], defaultWorkspace);
});

test('feat-002/AC-19 the narrowing permits enumeration but no operation on another environment', async () => {
  // Listing is deliberately wider than acting: Terraform enumerates workspaces and the cap
  // counts records, and neither can be done one key at a time. Seeing a name is not
  // reaching an environment.
  const policy = JSON.parse(
    sessionPolicyFor({ bucket: 'skyhook-acme', repository: REPO, identity: 'pr-482' }),
  ) as { Statement: Array<Record<string, unknown>> };

  const list = policy.Statement.find((s) => s['Sid'] === 'List');
  assert.deepEqual(list?.['Action'], ['s3:ListBucket']);
  assert.equal(list?.['Resource'], 'arn:aws:s3:::skyhook-acme');
  // Every object action stays out of the listing statement.
  assert.equal(JSON.stringify(list).includes('GetObject'), false);
});

test('feat-002/AC-19 the code says what the narrowing is worth, and not what it was once going to be', () => {
  // gap-003, from the first converge run. Both files below explained, as the reason this design
  // is safe, a boundary that chg-001 withdrew: a job_workflow_ref trust condition pinning these
  // credentials to a workflow stored on the default branch, so that "a pull request cannot edit
  // that workflow, so it cannot arrange to skip this". Nothing like it shipped. AC-19's own
  // closing sentence says the opposite — the narrowing is a property of what skyhook ASKS FOR,
  // "not a boundary the cloud enforces against a caller who declines to ask".
  //
  // The behavior was never wrong; the account of it was. That matters because the reader most
  // likely to be misled is someone deciding whether a change here weakens a cloud-enforced
  // guarantee, when there is none to weaken. This feature has been bitten by stale prose twice
  // already — the role-assumption message and the deploy-role advice both described the same
  // withdrawn design, and both were found only by reading a real failure in a live run.
  //
  // Asserted the way roles.tf's boundary block already is (feat-001/AC-18): the new framing must
  // be PRESENT and the withdrawn claim ABSENT. Presence alone would pass over prose that says
  // both things in different paragraphs, which is exactly the state this test exists to end.
  // Read flattened: a comment wraps where the column runs out, so matching raw source would
  // assert on where a sentence happens to break rather than on what it says, and reflowing a
  // paragraph would fail this test for no reason anyone would believe.
  const read = (path: string): string =>
    readFileSync(new URL(`../src/adapters/aws/${path}`, import.meta.url), 'utf8')
      .replace(/^\s*\*\s?/gm, '')
      .replace(/\s+/g, ' ');

  for (const file of ['session-policy.ts', 'broker.ts']) {
    const source = read(file);
    assert.match(
      source,
      /guardrail against accident rather than a boundary the cloud enforces|guardrail against accident, not a boundary the cloud enforces/,
      `${file} does not say the preview-to-preview boundary is skyhook's own`,
    );
    assert.match(
      source,
      /Preview environments are not isolated from each other/,
      `${file} does not point at the constitution clause that calls this a decision`,
    );
    assert.doesNotMatch(
      source,
      /cannot arrange to skip this|structural rather than a promise|not editable from a pull request/,
      `${file} still claims a boundary that chg-001 withdrew`,
    );
  }

  // The narrowing being skyhook's own does not soften what the CLOUD refuses, and the two must
  // not blur back together: a reader who takes AC-19 for AC-7 concludes that everything here is
  // merely advisory, which is untrue of every environment outside the ephemeral namespace.
  assert.match(
    read('session-policy.ts'),
    /roles\.tf|AC-7/,
    'nothing sends the reader to where the cloud-enforced floor actually lives',
  );
});

test('feat-002/AC-7 no pull-request run may write a protection mark', async () => {
  // The session policy no longer says this in its own statement. That statement was belt and
  // braces, and it was spent to buy the default-workspace read (chg-008) against a hard
  // 2048-character ceiling — with both, the worst plausible repository produced 2153 characters
  // and every deploy would have failed at assume time.
  //
  // So this asserts what actually refuses it now, in both places, rather than a statement that
  // happened to be convenient to grep for.
  const policy = JSON.parse(
    sessionPolicyFor({ bucket: 'skyhook-acme', repository: REPO, identity: 'pr-482' }),
  ) as { Statement: Array<Record<string, unknown>> };

  // One: the session names only this environment's own keys, and denies everything it does not
  // name — a protection mark is not among them.
  const deny = policy.Statement.find((s) => s['Sid'] === 'NoOthers');
  const exempt = deny?.['NotResource'] as string[];
  assert.equal(deny?.['Effect'], 'Deny');
  assert.equal(
    exempt.some((resource) => resource.includes('/protected/')),
    false,
    'no protection mark is exempt from the deny',
  );

  // Two: the role itself carries an explicit deny that no session policy can widen. This is the
  // one that holds even if the narrowing above is never asked for. feat-003 narrowed it from
  // s3:* to everything-but-read (the constitution's third exception buys teardown the read);
  // the WRITE this criterion is about is exactly as refused as before.
  const roles = readFileSync(
    new URL('../terraform/bootstrap/roles.tf', import.meta.url).pathname,
    'utf8',
  );
  assert.match(roles, /sid\s*=\s*"DenyAllButReadingProtectionMarks"/);
  const roleDeny = roles.slice(roles.indexOf('DenyAllButReadingProtectionMarks'));
  assert.match(roleDeny.slice(0, 300), /not_actions\s*=\s*\["s3:GetObject"\]/);
  assert.match(roleDeny.slice(0, 300), /resources\s*=\s*\["\$\{local\.bucket_arn\}\/protected\/\*"\]/);
});

test('session policy: a plausible worst case stays inside the inline policy limit', async () => {
  // Exceeding it fails at assume time, in CI, at the moment credentials are needed —
  // nowhere a test would otherwise see it.
  const policy = sessionPolicyFor({
    // GitHub's own maxima: a 39-character owner, a 100-character repository name, and a
    // bucket at S3's 63-character limit. The identity is `pr-<number>`, so nine digits is
    // already far past any real pull request.
    bucket: 'a'.repeat(63),
    repository: `${'o'.repeat(39)}/${'n'.repeat(100)}`,
    identity: `pr-${'9'.repeat(9)}`,
  });
  assert.ok(
    policy.length < MAX_INLINE_POLICY_LENGTH,
    `session policy is ${policy.length} characters, over the ${MAX_INLINE_POLICY_LENGTH} limit`,
  );
});

// --- exchanging the token for credentials -----------------------------------------

const STS_OK = `<AssumeRoleWithWebIdentityResponse>
 <AssumeRoleWithWebIdentityResult>
  <AssumedRoleUser>
   <Arn>arn:aws:sts::123456789012:assumed-role/skyhook-pull-request/skyhook-pr-482</Arn>
  </AssumedRoleUser>
  <Credentials>
   <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
   <SecretAccessKey>secret</SecretAccessKey>
   <SessionToken>token</SessionToken>
   <Expiration>2026-08-14T01:00:00Z</Expiration>
  </Credentials>
 </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

test('sts: the account id comes back with the credentials, so no signed call is needed', async () => {
  // This is what lets every role identifier be derived rather than typed into settings:
  // the assumed-role ARN names the account, so skyhook never calls GetCallerIdentity and
  // never needs credentials in order to obtain credentials.
  const outcome = await assumeRoleWithWebIdentity(
    {
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123456789012:role/skyhook-pull-request',
      roleSessionName: 'skyhook-pr-482',
      webIdentityToken: 'jwt',
      policy: '{"Version":"2012-10-17"}',
    },
    { fetch: async () => new Response(STS_OK, { status: 200 }) },
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.credentials.accountId, '123456789012');
  assert.equal(outcome.ok && outcome.credentials.accessKeyId, 'ASIAEXAMPLE');
});

test('sts: the session policy and a short duration are actually sent', async () => {
  let body = '';
  await assumeRoleWithWebIdentity(
    {
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::1:role/r',
      roleSessionName: 'skyhook-pr-1',
      webIdentityToken: 'jwt',
      policy: '{"narrowed":true}',
      durationSeconds: 900,
    },
    {
      fetch: async (_url, init) => {
        body = String(init?.body ?? '');
        return new Response(STS_OK, { status: 200 });
      },
    },
  );

  assert.ok(body.includes('Policy=') && body.includes('narrowed'));
  assert.ok(body.includes('DurationSeconds=900'));
  // No signature: the token authenticates this call, which is why obtaining credentials
  // does not require credentials.
  assert.equal(body.includes('X-Amz-Signature'), false);
});

test('sts: a refusal carries the cloud\'s own code, so a trust failure is legible', async () => {
  const outcome = await assumeRoleWithWebIdentity(
    { region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/r', roleSessionName: 's', webIdentityToken: 'jwt' },
    {
      fetch: async () =>
        new Response(
          '<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>',
          { status: 403 },
        ),
    },
  );

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'AccessDenied');
});

test('sts: a half-formed response is a failure, never a partial credential', async () => {
  const outcome = await assumeRoleWithWebIdentity(
    { region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/r', roleSessionName: 's', webIdentityToken: 'jwt' },
    { fetch: async () => new Response('<Credentials><AccessKeyId>A</AccessKeyId></Credentials>', { status: 200 }) },
  );

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'MalformedResponse');
});

// --- the state location is skyhook's -----------------------------------------------

test('feat-002/AC-17 a definition carrying an override file is refused before anything runs', async () => {
  // The directory holds the pull request's own files, and Terraform lets any *_override.tf
  // override the backend. A one-line file would otherwise produce real infrastructure
  // whose state dies with the runner: an orphan by construction.
  const dir = scratch();
  writeFileSync(join(dir, 'main.tf'), 'resource "null_resource" "x" {}');
  writeFileSync(join(dir, 'zzz_override.tf'), 'terraform {\n  backend "local" {}\n}\n');

  const problem = detectStateHijack(dir);

  assert.notEqual(problem, null);
  assert.equal(problem?.includes('zzz_override.tf'), true);
  assert.equal(problem?.includes('override'), true);
});

test('feat-002/AC-17 a definition declaring its own backend is refused by name', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'main.tf'), 'terraform {\n  backend "s3" {\n    bucket = "theirs"\n  }\n}\n');

  const problem = detectStateHijack(dir);

  assert.equal(problem?.includes('main.tf'), true);
  assert.equal(problem?.includes('backend'), true);
});

test('feat-002/AC-17 a backend named only inside a comment is not mistaken for one', async () => {
  const dir = scratch();
  writeFileSync(
    join(dir, 'main.tf'),
    '# we used to declare backend "local" {} here\n/* backend "s3" {} */\nresource "null_resource" "x" {}\n',
  );

  assert.equal(detectStateHijack(dir), null);
});

test('feat-002/AC-17 an initialized backend that is not skyhook\'s stops the run before apply', async () => {
  // The denylist above only knows the tricks it knows. This asks Terraform what it
  // actually did, which stays true against a mechanism nobody has thought of.
  const dir = scratch();
  mkdirSync(join(dir, '.terraform'));
  writeFileSync(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'local', config: {} } }),
  );

  const problem = verifyBackend(dir, 'skyhook-acme', 'state/acme/widgets/pr-482/terraform.tfstate');

  assert.equal(problem?.includes('local'), true);
  assert.equal(problem?.toLowerCase().includes('nothing was applied'), true);
});

test('feat-002/AC-17 a backend pointing at another bucket stops the run before apply', async () => {
  const dir = scratch();
  mkdirSync(join(dir, '.terraform'));
  writeFileSync(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({
      backend: { type: 's3', config: { bucket: 'attacker', workspace_key_prefix: 'state/acme/widgets' } },
    }),
  );

  const problem = verifyBackend(dir, 'skyhook-acme', 'state/acme/widgets/pr-482/terraform.tfstate');
  assert.equal(problem?.includes('attacker'), true);
});

test('feat-002/AC-17 skyhook\'s own backend passes both checks', async () => {
  const dir = scratch();
  mkdirSync(join(dir, '.terraform'));
  writeFileSync(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({
      backend: {
        type: 's3',
        config: { bucket: 'skyhook-acme', workspace_key_prefix: 'state/acme/widgets' },
      },
    }),
  );

  assert.equal(verifyBackend(dir, 'skyhook-acme', 'state/acme/widgets/pr-482/terraform.tfstate'), null);
});

// --- the workspace is the identity ---------------------------------------------------

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ args: readonly string[]; options: RunOptions | undefined }> = [];
  readonly #results: Map<string, CommandResult> = new Map();

  respondTo(firstArg: string, result: CommandResult): void {
    this.#results.set(firstArg, result);
  }

  async run(_command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    const key = args[0] ?? '';
    return this.#results.get(key) ?? { code: 0, stdout: '', stderr: '' };
  }
}

const STATE_KEY = 'state/acme/widgets/pr-482/terraform.tfstate';

/**
 * A store that answers exactly one question: which keys exist under a prefix.
 *
 * Deliberately not the general-purpose `FakeStore`. The deployer needs one method, and a
 * double that throws on every other one proves it stays that way — reading the whole state
 * back would spend skyhook's own budget to learn one bit, and writing through this store at
 * all would mean the deployer had grown a second job.
 */
class StateStore implements Store {
  readonly #keys: readonly string[];
  readonly #refuse: string | undefined;

  constructor(keys: readonly string[], refuse?: string) {
    this.#keys = keys;
    this.#refuse = refuse;
  }

  async list(prefix: string): Promise<ListOutcome> {
    if (this.#refuse !== undefined) throw new Error(this.#refuse);
    return { ok: true, keys: this.#keys.filter((key) => key.startsWith(prefix)) };
  }

  createIfAbsent(): never {
    throw new Error('the deployer must not write through the store');
  }
  read(): never {
    throw new Error('the deployer must not fetch the state, only confirm it is there');
  }
  compareAndSwap(): never {
    throw new Error('the deployer must not write through the store');
  }
  delete(): never {
    throw new Error('the deployer must not delete through the store');
  }
}

/** The ordinary case: the apply wrote its state where skyhook pointed it. */
function stateLanded(): StateStore {
  return new StateStore([STATE_KEY]);
}

function environmentUnder(
  dir: string,
  runner: CommandRunner,
  now: () => number = () => 0,
  store: Store = stateLanded(),
): TerraformEnvironment {
  return new TerraformEnvironment({
    runner,
    repositoryRoot: dir,
    bucket: 'skyhook-acme',
    region: 'us-east-1',
    backendCredentials: { accessKeyId: 'BACKEND', secretAccessKey: 'bs', sessionToken: 'bt' },
    deployCredentials: { accessKeyId: 'DEPLOY', secretAccessKey: 'ds', sessionToken: 'dt' },
    store,
    now,
  });
}

function readyDirectory(): { root: string; infra: string } {
  const root = scratch();
  const infra = join(root, 'infrastructure');
  mkdirSync(infra);
  writeFileSync(join(infra, 'main.tf'), 'resource "null_resource" "x" {}');
  mkdirSync(join(infra, '.terraform'));
  writeFileSync(
    join(infra, '.terraform', 'terraform.tfstate'),
    JSON.stringify({
      backend: {
        type: 's3',
        config: { bucket: 'skyhook-acme', workspace_key_prefix: 'state/acme/widgets' },
      },
    }),
  );
  return { root, infra };
}

test('feat-002/AC-12 the identity is the workspace, and no variable is ever passed', async () => {
  // AC-12: the environment identity is readable by the definition without that definition
  // declaring an input variable skyhook supplies. It rides on the workspace name — so
  // there must be no -var anywhere in what skyhook runs.
  const { root } = readyDirectory();
  const runner = new RecordingRunner();
  runner.respondTo('output', { code: 0, stdout: '{"url":{"value":"https://pr-482.example"}}', stderr: '' });

  const outcome = await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.url, 'https://pr-482.example');

  // Selected after init, and created if this is the environment's first deploy. TF_WORKSPACE was
  // tried instead and does not CREATE a workspace, so the first deploy of a new environment died
  // at init with "Currently selected workspace does not exist" — found live, on the second
  // environment, because the first one's state predated the change (chg-008 against feat-001).
  const workspace = runner.calls.find((c) => c.args[0] === 'workspace');
  assert.deepEqual(workspace?.args, ['workspace', 'select', '-or-create=true', 'pr-482']);
  for (const call of runner.calls) {
    assert.equal(call.args.includes('-var'), false, `-var passed in: ${call.args.join(' ')}`);
  }
});

test('feat-002/AC-17 the state key terraform is pointed at is the one the roles already grant', async () => {
  const { root } = readyDirectory();
  const runner = new RecordingRunner();

  await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  const init = runner.calls.find((c) => c.args[0] === 'init');
  const flags = init?.args ?? [];
  assert.ok(flags.includes('-backend-config=workspace_key_prefix=state/acme/widgets'));
  assert.ok(flags.includes('-backend-config=key=terraform.tfstate'));
  assert.ok(flags.includes('-backend-config=use_lockfile=true'));
  assert.ok(flags.includes('-backend-config=encrypt=true'));
});

test('feat-002/AC-7 the backend authenticates separately from the providers', async () => {
  // One terraform run, two identities: the repository's own definition applies as its
  // deploy role, while the state it writes belongs to skyhook's narrowed session. If the
  // backend used the ambient credentials, the consuming repo's role would need access to
  // skyhook's bucket — and a repository that wrote that policy broadly would reach every
  // environment's state.
  const { root } = readyDirectory();
  const runner = new RecordingRunner();

  await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  const init = runner.calls.find((c) => c.args[0] === 'init');
  assert.ok(init?.args.includes('-backend-config=access_key=BACKEND'));

  const apply = runner.calls.find((c) => c.args[0] === 'apply');
  assert.equal(apply?.options?.env?.['AWS_ACCESS_KEY_ID'], 'DEPLOY');
});

test('feat-002/AC-18 a failing apply is reported as the repository\'s own', async () => {
  const { root } = readyDirectory();
  const runner = new RecordingRunner();
  runner.respondTo('apply', { code: 1, stdout: '', stderr: 'Error: invalid resource' });

  const outcome = await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, 'consumer-apply-failed');
  assert.equal(!outcome.ok && outcome.problem.includes('not of skyhook'), true);
});

test('feat-002/AC-13 a definition with no url output still deploys', async () => {
  const { root } = readyDirectory();
  const runner = new RecordingRunner();
  runner.respondTo('output', { code: 0, stdout: '{}', stderr: '' });

  const outcome = await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.url, null);
});

// --- the third state-location check ---------------------------------------------------

test('feat-002/AC-17 (gap-002) a successful apply whose state is not in the bucket is not a success', async () => {
  // Plan D6a's third defense, specified from the start and unbuilt until gap-002 found it.
  // The other two run BEFORE the apply and can both lapse: the first is a denylist, and the
  // second reads an internal Terraform file with no compatibility promise, so a shape change
  // makes it stop checking rather than fail. This one asks the object store, after the fact,
  // and is the only one that cannot go quiet.
  //
  // The fixture is the point. A store that reports the key present would pass just as
  // happily against a deployer that never looks — which is the state this test ends.
  const { root } = readyDirectory();
  const runner = new RecordingRunner();

  const outcome = await environmentUnder(root, runner, () => 0, new StateStore([])).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, false);
  // Skyhook's own failure, not the repository's: its Terraform did exactly what it was
  // asked, and what could not be kept is skyhook's promise that this can be found again.
  assert.equal(!outcome.ok && outcome.reason, 'skyhook-failed');
  assert.equal(!outcome.ok && outcome.problem.includes(STATE_KEY), true);
  assert.equal(!outcome.ok && outcome.problem.includes('ORPHAN'), true);
});

test('feat-002/AC-17 (gap-002) a store that cannot answer is reported, never passed over', async () => {
  // "Could not confirm" is a different sentence from "confirmed missing", and neither may
  // read as success. A check whose failure mode is silence is the failure mode this whole
  // defense exists to avoid.
  const { root } = readyDirectory();
  const runner = new RecordingRunner();
  const refusing = new StateStore([], 'AccessDenied: not authorized to perform s3:ListBucket');

  const outcome = await environmentUnder(root, runner, () => 0, refusing).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, 'skyhook-failed');
  assert.equal(!outcome.ok && outcome.problem.includes('could not confirm'), true);
  assert.equal(!outcome.ok && outcome.problem.includes('AccessDenied'), true);
});

test('feat-002/AC-17 (gap-002) the check runs after the apply, and reads no state back', async () => {
  // After, because it is asking what the apply actually did — the two checks that run before
  // it are asking what it is about to be allowed to do. And by listing rather than fetching:
  // a managed environment's state can be large, everything after the apply is counted
  // against skyhook's own 60 seconds (AC-14), and the question is one bit. `StateStore`
  // throws on `read`, so a deployer that fetched the state would fail here.
  const { root } = readyDirectory();
  const runner = new RecordingRunner();

  const outcome = await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, true);
  assert.ok(runner.calls.some((call) => call.args[0] === 'apply'));
});

// --- where the budget's line actually falls ------------------------------------------

/**
 * A runner that burns a recognisable, and different, amount of clock per terraform command.
 *
 * The shape is the point. A test that is *handed* a `{preparationMs, initMs, applyMs}` split
 * can only check that somebody subtracts the right field; it can never see the deployer put
 * a duration in the wrong bucket. That is exactly how `gap-001` survived a green suite for
 * the whole of this feature — the existing AC-14 test drives a `FakeDeployer` whose split is
 * its input. Here the deployer has to compute the split, and each command costs a distinct
 * number, so a misplaced figure names the command that leaked rather than just failing an
 * equality.
 */
class ClockRunner implements CommandRunner {
  readonly calls: string[] = [];
  readonly #costs: Readonly<Record<string, number>>;
  readonly #results: Map<string, CommandResult>;
  #elapsed = 0;

  constructor(
    costs: Readonly<Record<string, number>>,
    results: Readonly<Record<string, CommandResult>> = {},
  ) {
    this.#costs = costs;
    this.#results = new Map(Object.entries(results));
  }

  readonly now = (): number => this.#elapsed;

  async run(_command: string, args: readonly string[]): Promise<CommandResult> {
    const key = args[0] ?? '';
    this.calls.push(key);
    this.#elapsed += this.#costs[key] ?? 0;
    return this.#results.get(key) ?? { code: 0, stdout: '', stderr: '' };
  }
}

const INIT_MS = 5_000; // the repository's providers and modules arriving
const WORKSPACE_MS = 700; // skyhook selecting this environment's copy
const APPLY_MS = 30_000; // the repository's own infrastructure
const OUTPUT_MS = 40; // skyhook reading the address back

test("feat-002/AC-14 (gap-001) terraform init is the repository's time, and the deployer says so", async () => {
  // AC-14 excludes two things and both are the consuming repository's: applying its
  // infrastructure, and the step in which terraform prepares that definition beforehand.
  // Charging init to skyhook makes the 60-second budget a measure of somebody else's
  // dependency tree — plan D7a rules it out in as many words, and the code did it anyway.
  const { root } = readyDirectory();
  const runner = new ClockRunner(
    { init: INIT_MS, workspace: WORKSPACE_MS, apply: APPLY_MS, output: OUTPUT_MS },
    { output: { code: 0, stdout: '{"url":{"value":"https://pr-482.example"}}', stderr: '' } },
  );

  const outcome = await environmentUnder(root, runner, runner.now).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.timing.initMs, INIT_MS);
  assert.equal(outcome.timing.applyMs, APPLY_MS);
  // Everything in the pre-apply window that was not init: the hijack check, writing the
  // backend declaration, reading terraform's backend record, and selecting the workspace.
  // Only the last one costs anything on this clock, which is what makes the number legible.
  assert.equal(outcome.timing.preparationMs, WORKSPACE_MS);
});

test("feat-002/AC-14 (gap-001) an init that fails spent the repository's time, not skyhook's", async () => {
  // The early returns are where a split like this usually rots: the happy path gets the
  // careful accounting and a failure hands back whatever was easiest. A provider that takes
  // four minutes to fail to download is still not skyhook being slow.
  const { root } = readyDirectory();
  const runner = new ClockRunner(
    { init: INIT_MS },
    { init: { code: 1, stdout: '', stderr: 'Error: failed to query available provider packages' } },
  );

  const outcome = await environmentUnder(root, runner, runner.now).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.timing.initMs, INIT_MS);
  assert.equal(outcome.timing.preparationMs, 0);
  assert.equal(outcome.timing.applyMs, 0);
});

test('feat-002/AC-14 (gap-001) work nobody instrumented lands on skyhook, not in the gap', async () => {
  // AC-14's closing requirement: of the seconds that do fall to skyhook, none may go
  // missing. The deployer computes its own share by subtracting init from the whole
  // pre-apply window rather than by adding up the steps it remembered to time — so a step
  // added later without a stopwatch is counted against skyhook instead of vanishing.
  // `workspace` here stands in for that unmeasured step: nothing names it, and it still
  // arrives in preparationMs.
  const { root } = readyDirectory();
  const runner = new ClockRunner({ init: INIT_MS, workspace: 1_234, apply: APPLY_MS });

  const outcome = await environmentUnder(root, runner, runner.now).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.timing.preparationMs, 1_234);
});

test('feat-002/AC-17 skyhook removes its own backend file, including when the run fails', async () => {
  // Left behind it would silently pin a later run — the exact defect shape that cost
  // feat-001 a failed removal and a first-run bootstrap broken for weeks.
  const { root, infra } = readyDirectory();
  const runner = new RecordingRunner();
  runner.respondTo('apply', { code: 1, stdout: '', stderr: 'boom' });

  await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  const { readdirSync } = await import('node:fs');
  assert.equal(readdirSync(infra).includes('zz_skyhook_backend.tf'), false);
});

// --- the broker asks for the role the trigger earns (feat-006 plan D4) ------------

function brokerFixture(): {
  broker: AwsAccessBroker;
  config: SkyhookConfig;
  stsBodies: string[];
} {
  const stsBodies: string[] = [];
  const fetchFake: typeof globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('token.actions')) {
      return new Response(JSON.stringify({ value: 'jwt' }), { status: 200 });
    }
    stsBodies.push(String(init?.body ?? ''));
    return new Response(STS_OK, { status: 200 });
  };
  const broker = new AwsAccessBroker({
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.test/?a=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req',
    },
    runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    repositoryRoot: '.',
    fetch: fetchFake,
  });
  const config: SkyhookConfig = {
    environmentCap: { enabled: true, limit: 5 },
    storage: { bucket: 'skyhook-acme', region: 'us-east-1', account: '123456789012' },
    deploy: { directory: 'infrastructure', rolePrefix: 'skyhook', inputs: [] },
    pool: null,
  };
  return { broker, config, stsBodies };
}

test('broker: a pull-request trigger asks for the pull-request role, narrowed to its environment', async () => {
  const { broker, config, stsBodies } = brokerFixture();

  const outcome = await broker.open({
    config,
    repository: REPO,
    identity: 'pr-482',
    triggerKind: 'pull-request',
  });

  assert.equal(outcome.ok, true);
  const first = stsBodies[0] ?? '';
  assert.ok(decodeURIComponent(first).includes('role/skyhook-pull-request'), 'expected the pull-request role');
  assert.ok(first.includes('Policy='), 'expected the session narrowed to the claimed environment');
});

test('broker: a default-branch trigger asks for the default-branch role, narrowed the same way', async () => {
  const { broker, config, stsBodies } = brokerFixture();

  const outcome = await broker.open({
    config,
    repository: REPO,
    identity: 'staging',
    triggerKind: 'default-branch',
  });

  assert.equal(outcome.ok, true);
  const first = stsBodies[0] ?? '';
  assert.ok(decodeURIComponent(first).includes('role/skyhook-default-branch'), 'expected the default-branch role');
  assert.ok(first.includes('Policy='), 'expected the session narrowed to the claimed environment');
});

test('broker: manual access rides the default-branch role, wide like the sweep', async () => {
  const { broker, config, stsBodies } = brokerFixture();

  const outcome = await broker.openManual(config, REPO);

  assert.equal(outcome.ok, true);
  const first = stsBodies[0] ?? '';
  assert.ok(decodeURIComponent(first).includes('role/skyhook-default-branch'), 'expected the default-branch role');
  // Wide by design: the registry/store session carries no narrowing policy, exactly as
  // the sweep's — the guardrail gap is recorded in the plan (D6).
  assert.equal(first.includes('Policy='), false);
});

// --- every output handed back (chg-008) ---------------------------------------

test('feat-002/AC-24 the adapter returns every non-sensitive output verbatim, omitting sensitive by name', async () => {
  const { root } = readyDirectory();
  const runner = new RecordingRunner();
  // Terraform's own -json shape: each output an object with value + sensitive.
  runner.respondTo('output', {
    code: 0,
    stdout: JSON.stringify({
      url: { value: 'https://pr-482.example', sensitive: false },
      web_bucket: { value: 'skyhook-acme-pr-482-web', sensitive: false },
      cdn: { value: { id: 'E123', domain: 'd1.cloudfront.net' }, sensitive: false },
      db_password: { value: 'hunter2', sensitive: true },
    }),
    stderr: '',
  });

  const outcome = await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // url still handed back on its own, unchanged.
  assert.equal(outcome.url, 'https://pr-482.example');
  // Every non-sensitive output, values verbatim including the nested object.
  assert.deepEqual(outcome.outputs?.document, {
    url: 'https://pr-482.example',
    web_bucket: 'skyhook-acme-pr-482-web',
    cdn: { id: 'E123', domain: 'd1.cloudfront.net' },
  });
  // The sensitive one is omitted from the document and named so the caller can log it.
  assert.ok(!('db_password' in (outcome.outputs?.document ?? {})), 'sensitive value omitted');
  assert.deepEqual(outcome.outputs?.omittedSensitive, ['db_password']);
});

test('feat-002/AC-24 a definition with no outputs yields an empty document, not null', async () => {
  const { root } = readyDirectory();
  const runner = new RecordingRunner();
  runner.respondTo('output', { code: 0, stdout: '{}', stderr: '' });

  const outcome = await environmentUnder(root, runner).deploy({
    repository: REPO,
    identity: 'pr-482',
    directory: 'infrastructure',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.url, null);
  assert.deepEqual(outcome.outputs?.document, {});
  assert.deepEqual(outcome.outputs?.omittedSensitive, []);
});
