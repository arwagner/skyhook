import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { init, desiredFiles } from '../src/cli/init.ts';
import { changed, ensureRegistry, REGISTRY_MARKER_KEY } from '../src/core/install.ts';
import { parseConfig } from '../src/core/config.ts';
import { FakeStore } from './fake-store.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'skyhook-init-'));
}

const OPTIONS = {
  repository: 'acme/widgets',
  bucket: 'skyhook-acme-widgets',
  region: 'eu-west-1',
};

function everyFileUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return found.sort();
}

// --- AC-1: first installation ----------------------------------------------

test('feat-001/AC-1 init creates the config, the calling workflow, and the bootstrap definition', () => {
  const root = scratch();
  try {
    const result = init({ repositoryRoot: root, ...OPTIONS });

    const written = everyFileUnder(root);
    assert.ok(written.includes('.skyhook/config.yml'), 'the configuration file');
    assert.ok(written.includes('.skyhook/workflow.yml'), 'the workflow that calls skyhook');
    assert.ok(
      written.some((p) => p.startsWith('.skyhook/bootstrap/') && p.endsWith('.tf')),
      'the bootstrap infrastructure definition',
    );
    assert.ok(
      written.every((p) => p.startsWith('.skyhook/')),
      'init writes nothing outside .skyhook/',
    );
    assert.ok(result.report.changes.every((c) => c.kind === 'created'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-1 init applies nothing — no cloud resource is created', () => {
  const root = scratch();
  try {
    const result = init({ repositoryRoot: root, ...OPTIONS });
    // The evidence available in-process: init is synchronous, takes no credentials, and its
    // report mentions only files. What it produces is a definition for a human to apply.
    // The applying step is named rather than performed — chg-009 moved which command an operator
    // is sent to (`skyhook bootstrap`, which can supply the subject the trust policies pin) but
    // not the property under test, which is that init itself creates nothing.
    assert.ok(result.messages.some((m) => /skyhook bootstrap/i.test(m)));
    assert.ok(result.messages.some((m) => /nothing has been created/i.test(m)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-1 the config init writes parses back to the settings it was given', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const document = readFileSync(join(root, '.skyhook/config.yml'), 'utf8');
    // Round-trips through the real parser rather than a regex, so a config init writes but
    // skyhook cannot read would fail here rather than at run time.
    const parsed = parseConfig(document);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.config.storage.bucket, OPTIONS.bucket);
    assert.equal(parsed.config.storage.region, OPTIONS.region);
    assert.deepEqual(parsed.config.environmentCap, { enabled: true, limit: 5 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-2: re-run is idempotent --------------------------------------------

test('feat-001/AC-2 a second init leaves every managed file byte-identical', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const before = new Map(
      everyFileUnder(root).map((p) => [p, readFileSync(join(root, p), 'utf8')] as const),
    );

    const second = init({ repositoryRoot: root, ...OPTIONS });

    for (const [path, content] of before) {
      assert.equal(readFileSync(join(root, path), 'utf8'), content, `${path} changed`);
    }
    // Asserts what this test exists to assert — a re-run WRITES nothing — rather than the report's
    // encoding of it. The settings file now reports `kept` rather than `unchanged` (chg-002), which
    // is a different statement about the same non-event.
    assert.ok(
      second.report.changes.every((c) => c.kind !== 'created' && c.kind !== 'restored'),
      'the re-run writes nothing',
    );
    assert.ok(second.messages.some((m) => /already up to date/i.test(m)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-2 a second init creates no duplicate alongside the original', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const first = everyFileUnder(root);
    init({ repositoryRoot: root, ...OPTIONS });
    assert.deepEqual(everyFileUnder(root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-13: partial or altered installation --------------------------------

test('feat-001/AC-13 a deleted managed file is restored and reported', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const victim = join(root, '.skyhook/config.yml');
    const original = readFileSync(victim, 'utf8');
    rmSync(victim);

    const repair = init({ repositoryRoot: root, ...OPTIONS });

    assert.equal(readFileSync(victim, 'utf8'), original);
    const change = repair.report.changes.find((c) => c.path === '.skyhook/config.yml');
    assert.equal(change?.kind, 'created');
    assert.ok(repair.messages.some((m) => m.includes('.skyhook/config.yml')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-13 a hand-edited managed file is restored, not merged, and reported', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const victim = join(root, '.skyhook/workflow.yml');
    const original = readFileSync(victim, 'utf8');
    writeFileSync(victim, '# someone edited this by hand\n');

    const repair = init({ repositoryRoot: root, ...OPTIONS });

    assert.equal(readFileSync(victim, 'utf8'), original, 'restored to desired content');
    assert.doesNotMatch(readFileSync(victim, 'utf8'), /edited this by hand/, 'never merged');
    const change = repair.report.changes.find((c) => c.path === '.skyhook/workflow.yml');
    assert.equal(change?.kind, 'restored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-13 a file skyhook does not manage is never touched', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const bystander = join(root, '.skyhook/notes-from-the-operator.md');
    writeFileSync(bystander, 'mine, not skyhook\'s\n');

    init({ repositoryRoot: root, ...OPTIONS });

    assert.equal(readFileSync(bystander, 'utf8'), 'mine, not skyhook\'s\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- feat-002/AC-15: the scaffolded workflow must actually parse as YAML ---

test('feat-002/AC-15 no value in the scaffolded workflow is an unquoted scalar holding a colon', () => {
  // Found by the first live run, and it had never worked: `run: echo "Environment: ${{ ... }}"`
  // is not valid YAML. A plain scalar may not contain ": " — the parser reads it as a key — so
  // the whole file failed to parse, every time, for every consumer.
  //
  // What made it expensive is how GitHub reports it. There is no error on the pull request. The
  // trigger simply never fires; a failed run is attributed to the *push* that introduced the
  // file, the workflow is listed under its own path instead of its name, and the only message is
  // "This run likely failed because of a workflow file issue". None of that names the line.
  //
  // Asserts the class, because the next scaffolded echo with a colon in it will be written by
  // someone who has never heard of this.
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const workflow = readFileSync(join(root, '.skyhook/workflow.yml'), 'utf8');

    for (const [index, line] of workflow.split('\n').entries()) {
      if (/^\s*#/.test(line) || line.trim() === '') continue;
      const match = /^\s*(?:-\s*)?[A-Za-z_][\w-]*:\s+(.*)$/.exec(line);
      const value = match?.[1];
      if (value === undefined) continue;
      // A quoted scalar may hold anything; only a plain one is at risk.
      if (/^['"]/.test(value)) continue;
      assert.ok(
        !value.includes(': '),
        `.skyhook/workflow.yml line ${index + 1} is a plain scalar holding ": ", which makes ` +
          `the file unparseable. Quote it.\n  ${line.trim()}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- feat-002/AC-20, AC-21: the settings file is seeded, not restored (chg-002) ---

test('feat-002/AC-20 a hand-edited settings file survives a re-run while an owned file is restored', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });

    // The operator answers the two questions init could not answer for them...
    const settings = join(root, '.skyhook/config.yml');
    const answered = readFileSync(settings, 'utf8')
      .replace('#account: "000000000000"', 'account: "123456789012"')
      .replace(/^#deploy:$/m, 'deploy:')
      .replace(/^#  directory: infra$/m, '  directory: infra');
    writeFileSync(settings, answered);

    // ...and in the same breath, something skyhook owns gets edited too.
    const owned = join(root, '.skyhook/workflow.yml');
    const ownedOriginal = readFileSync(owned, 'utf8');
    writeFileSync(owned, '# someone edited this by hand\n');

    const second = init({ repositoryRoot: root, ...OPTIONS });

    // Both halves together on purpose: asserting only the first would pass just as well if init
    // had stopped writing anything at all, which is the likelier way to break this.
    assert.equal(readFileSync(settings, 'utf8'), answered, 'the operator\'s answers survive');
    assert.equal(readFileSync(owned, 'utf8'), ownedOriginal, 'a file skyhook owns is still restored');

    assert.equal(second.report.changes.find((c) => c.path === '.skyhook/config.yml')?.kind, 'kept');
    assert.equal(
      second.report.changes.find((c) => c.path === '.skyhook/workflow.yml')?.kind,
      'restored',
    );

    // The report must not claim init changed the settings file, and must not stay silent about it
    // either — an operator expecting a repair has to learn here that none is coming.
    assert.ok(
      !changed(second.report).some((c) => c.path === '.skyhook/config.yml'),
      'not counted as something skyhook wrote',
    );
    assert.ok(
      second.messages.some((m) => m.includes('.skyhook/config.yml') && /left alone/.test(m)),
      'reported as left alone',
    );

    // And the answers still read back as answers, not as prose that happens to survive.
    const parsed = parseConfig(readFileSync(settings, 'utf8'));
    assert.ok(parsed.ok);
    assert.equal(parsed.config.storage.account, '123456789012');
    assert.equal(parsed.config.deploy?.directory, 'infra');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-002/AC-21 the seeded settings file parses as written, with every blank labelled', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const document = readFileSync(join(root, '.skyhook/config.yml'), 'utf8');

    // Inert, not broken: a fresh installation runs bootstrap and destruct before anyone fills
    // anything in, so the commented placeholders must not make the document unreadable.
    const parsed = parseConfig(document);
    assert.ok(parsed.ok, `a freshly seeded settings file must parse: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.config.storage.account, null, 'the account is absent, not guessed');
    assert.equal(parsed.config.deploy, null, 'a fresh installation does not deploy');

    // Each blank names itself and where its value comes from, so filling it in is completing a
    // labelled slot rather than reconstructing a key name from the documentation.
    assert.match(document, /#account:/, 'a slot for the account');
    assert.match(document, /account_id/, 'and where the account comes from');
    assert.match(document, /#deploy:/, 'a slot for the deploy block');
    assert.match(document, /#  directory:/, 'including the setting that block requires');
    assert.match(document, /deploy-role\.example\.tf/, 'and where the role it names comes from');

    // The rule itself is stated in the file, because the file is where someone reads it.
    assert.match(document, /THIS FILE IS YOURS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-11: no credentials ever written ------------------------------------

test('feat-001/AC-11 nothing init produces contains credential-shaped content', () => {
  // A heuristic, not a proof: it catches the accident it is aimed at, not a determined leak.
  const patterns: readonly [string, RegExp][] = [
    ['AWS access key id', /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/],
    ['AWS secret access key assignment', /aws_secret_access_key\s*[:=]/i],
    ['generic secret assignment', /\b(?:secret_key|secret_access_key|password)\s*[:=]\s*\S/i],
    ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ];

  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    for (const path of everyFileUnder(root)) {
      const content = readFileSync(join(root, path), 'utf8');
      for (const [name, pattern] of patterns) {
        assert.doesNotMatch(content, pattern, `${path} looks like it contains a ${name}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-11 the workflow authenticates by federation, never by a stored key', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const workflow = readFileSync(join(root, '.skyhook/workflow.yml'), 'utf8');
    assert.match(workflow, /id-token:\s*write/, 'requests an OIDC token');
    assert.doesNotMatch(workflow, /aws-access-key-id/i);
    assert.doesNotMatch(workflow, /aws-secret-access-key/i);
    // Skyhook exchanges the OIDC token for credentials itself (feat-002 plan D3) rather than
    // asking the workflow to, so there is no role ARN in this file to get wrong — and no
    // third-party action standing between the token and the narrowing skyhook applies to it.
    assert.doesNotMatch(workflow, /role-to-assume/);
    assert.doesNotMatch(workflow, /configure-aws-credentials/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-18: the known limit reaches the operator ----------------------------

test('feat-001/AC-18 init tells the operator the pull-request-to-pull-request limit', () => {
  const root = scratch();
  try {
    const result = init({ repositoryRoot: root, ...OPTIONS });
    const said = result.messages.join('\n');
    assert.match(said, /pull request/i);
    assert.match(said, /not only its own|other pull requests/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-18 the operator is told what the open boundary costs, not only where it is', () => {
  // chg-001 turned this from a gap awaiting a fix into a decision. A decision an operator is not
  // told the price of is worse than a gap they were warned about: the price here is that one
  // preview's state — credentials and all — is readable by another.
  const root = scratch();
  try {
    const said = init({ repositoryRoot: root, ...OPTIONS }).messages.join('\n');
    assert.match(said, /state/i, 'never mentions where the readable material lives');
    assert.match(said, /secret|credential/i, 'never says what is in it');
    assert.doesNotMatch(
      said,
      /KNOWN LIMIT|not closed|awaiting|yet\b/i,
      'still frames a settled decision as pending work',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- feat-002 phase 5: what init scaffolds for a deploy ---------------------

test('feat-002/AC-15 the scaffolded workflow runs skyhook and hands no secrets to it', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const workflow = readFileSync(join(root, '.skyhook/workflow.yml'), 'utf8');

    assert.match(workflow, /uses: arwagner\/skyhook@/, 'never actually calls skyhook');
    assert.doesNotMatch(workflow, /not built yet/, 'still claims the action does not exist');

    // The one that matters. `secrets: inherit` would hand every repository secret to a job
    // running a pull request's own Terraform — and this file is one a pull request may edit.
    assert.doesNotMatch(workflow, /secrets:\s*inherit/);

    // AC-15: skyhook asks for no permission to write to the pull request.
    assert.doesNotMatch(workflow, /pull-requests:\s*write/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-002/AC-15 exactly one workflow is scaffolded, and it says what editing it changes', () => {
  // chg-001 collapsed the caller/trusted-workflow pair to one file. The pair existed only to pin
  // credentials to a workflow a pull request could not edit; with that gone, a second file would
  // be indirection standing in for a boundary that is no longer claimed.
  const root = scratch();
  try {
    const workflows = desiredFiles({ repositoryRoot: root, ...OPTIONS }).filter((f) =>
      /workflow/.test(f.path),
    );
    assert.equal(workflows.length, 1, `expected one workflow, got ${workflows.map((f) => f.path).join(', ')}`);

    const workflow = workflows[0]!.content;
    assert.doesNotMatch(workflow, /workflow_call/, 'still scaffolds a reusable workflow');
    assert.doesNotMatch(workflow, /job_workflow_ref/);
    // A pull request may edit this file, so it has to say what that does and does not buy.
    assert.match(workflow, /NO wider credentials|no wider credentials/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-002/AC-11 init scaffolds a deploy role it never applies, and says what its trust misses', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const example = readFileSync(join(root, '.skyhook/deploy-role.example.tf'), 'utf8');

    // StringEquals, never StringLike: a wildcard subject trusts every branch and tag.
    // The operator, not only the value: a trailing wildcard on the subject accepts every branch
    // and tag, which is the failure mode the file's own comment warns about — so assert on what
    // the policy actually uses rather than on whether the word appears in prose explaining it.
    assert.match(example, /test\s*=\s*"StringEquals"[\s\S]*?:sub"/);
    assert.doesNotMatch(example, /test\s*=\s*"StringLike"/);
    assert.doesNotMatch(example, /job_workflow_ref/, 'pins a workflow chg-001 withdrew');

    // Permissions are left blank on purpose — an example wide enough to work is wide enough to
    // copy unread — and the file says what the trust does NOT buy, which is the part a
    // maintainer will otherwise assume.
    assert.match(example, /does not buy|DOES NOT BUY/i);
    assert.match(example, /every pull request|any pull-request run/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-002/AC-11 init states the order, and that the workflow must reach the default branch', () => {
  // Also feat-001/AC-30 — init writes everything a repository needs to deploy, applies none of it,
  // and states the order in which those files must reach the default branch. Two features'
  // criteria meet in one assertion because it is one behaviour: the backing store owns what init
  // writes, the deploy action owns what consumes it.
  // Plan D12. Getting this wrong is silent: GitHub reads pull_request triggers from the default
  // branch, so a workflow living only on a branch runs nothing and explains nothing.
  const root = scratch();
  try {
    const said = init({ repositoryRoot: root, ...OPTIONS }).messages.join('\n');
    assert.match(said, /default branch/i);
    assert.match(said, /order/i);
    assert.match(said, /deploy-role\.example\.tf/, 'never points at the role the maintainer must declare');
    assert.match(said, /storage\.account/, 'never says where the account id goes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- desired set is stable --------------------------------------------------

test('install: the desired file set is a pure function of the options', () => {
  const one = desiredFiles({ repositoryRoot: '/a', ...OPTIONS });
  const other = desiredFiles({ repositoryRoot: '/b', ...OPTIONS });
  assert.deepEqual(one, other, 'the root is where files go, not what they contain');
});

// --- AC-4: the registry self-heals, the bucket does not ---------------------

test('feat-001/AC-4 an empty bucket gets a registry and the run proceeds', async () => {
  const store = new FakeStore();
  const outcome = await ensureRegistry(store, 'skyhook-acme-widgets');
  assert.deepEqual(outcome, { ok: true, created: true });
  assert.ok(store.allKeys().includes(REGISTRY_MARKER_KEY));
});

test('feat-001/AC-4 an existing registry is left alone and the run proceeds', async () => {
  const store = new FakeStore();
  await ensureRegistry(store, 'skyhook-acme-widgets');
  const second = await ensureRegistry(store, 'skyhook-acme-widgets');
  assert.deepEqual(second, { ok: true, created: false });
});

test('feat-001/AC-4 two runs initializing at once resolve like two claims', async () => {
  // No lock is needed: this is the same create-if-absent primitive a claim uses. One wins,
  // the loser is told, and both proceed.
  let release = (): void => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  const store = new FakeStore({
    beforeCommit: async () => {
      arrived += 1;
      if (arrived <= 2) await parked;
    },
  });

  const both = Promise.all([
    ensureRegistry(store, 'skyhook-acme-widgets'),
    ensureRegistry(store, 'skyhook-acme-widgets'),
  ]);
  await Promise.resolve();
  release();
  const [a, b] = await both;

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal([a, b].filter((o) => o.ok && o.created).length, 1, 'exactly one created it');
});

test('feat-001/AC-4 a missing bucket stops the run by name, and creates nothing', async () => {
  const store = new FakeStore({ containerExists: false });
  const outcome = await ensureRegistry(store, 'skyhook-acme-widgets');

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, 'container-missing');
  assert.equal(outcome.bucket, 'skyhook-acme-widgets', 'the message names the bucket');
  assert.deepEqual(store.allKeys(), [], 'the bootstrap owns the bucket; skyhook creates nothing');
});

test('feat-001/AC-1 init states which of its files belong in version control', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const ignore = readFileSync(join(root, '.skyhook/.gitignore'), 'utf8');

    // State is ignored — after the first bootstrap it lives in the bucket, and a copy left
    // here can hold values nobody wants in git.
    assert.match(ignore, /^\*\.tfstate$/m);
    assert.match(ignore, /^\.terraform\/$/m);

    // The lock file is NOT ignored: it pins provider versions, and a change to it is a change
    // a reviewer should see.
    assert.match(ignore, /^!\.terraform\.lock\.hcl$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- feat-003/AC-12: teardown wiring arrives the same way the workflow arrived ---

test('feat-003/AC-12 a fresh install carries the close and schedule wiring from the start', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const workflow = readFileSync(join(root, '.skyhook/workflow.yml'), 'utf8');
    assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
    assert.match(workflow, /pull-requests: read/);
    const example = readFileSync(join(root, '.skyhook/deploy-role.example.tf'), 'utf8');
    assert.match(example, /:ref:refs\/heads\/\$\{var\.skyhook_default_branch\}/, 'the sweep cannot assume the deploy role');
    assert.match(example, /widest identity/, 'the widened trust does not state its blast radius');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-003/AC-12 re-running init over a pre-teardown installation updates the workflow and reports it', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });

    // A workflow written before teardown existed: no closed type, no schedule.
    const workflowPath = join(root, '.skyhook/workflow.yml');
    const preTeardown = readFileSync(workflowPath, 'utf8')
      .replace('types: [opened, synchronize, reopened, closed]', 'types: [opened, synchronize, reopened]')
      .replace(/  schedule:\n.*\n/, '');
    writeFileSync(workflowPath, preTeardown);

    const second = init({ repositoryRoot: root, ...OPTIONS });

    const workflow = readFileSync(workflowPath, 'utf8');
    assert.match(workflow, /closed\]/);
    assert.match(workflow, /schedule:/);
    assert.equal(
      second.report.changes.find((c) => c.path === '.skyhook/workflow.yml')?.kind,
      'restored',
      'the update went unreported',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-35 the seeded settings file warns, beside the inputs slot, that values are recorded in the clear', () => {
  const root = scratch();
  try {
    init({ repositoryRoot: root, ...OPTIONS });
    const document = readFileSync(join(root, '.skyhook/config.yml'), 'utf8');

    // Still inert: the new slots are commented, and a fresh file must keep parsing.
    assert.ok(parseConfig(document).ok);

    assert.match(document, /#  inputs:/, 'a slot for the declared deploy inputs');
    // The warning lives where the operator declares a name, not only in the specification:
    // recorded values land in the registry in the clear and appear on the dashboard, so a
    // secret must never travel through a declared input.
    assert.match(document, /in the clear/);
    assert.match(document, /[Nn]ever a secret|no secret|NOT a secret/);
    assert.match(
      document,
      /allow_sensitive_input_names/,
      'the per-name exception is named where it would be used',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
