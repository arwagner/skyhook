import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Store } from '../src/adapters/aws/s3-store.ts';
import { GitHubConfigSource } from '../src/adapters/github/config-source.ts';
import { subjectPrefix } from '../src/adapters/github/repository-ids.ts';
import { signRequest } from '../src/adapters/aws/sigv4.ts';

/**
 * These exercise the requests each adapter *sends* — the headers a conditional write depends on,
 * and the ref a config read is pinned to. Whether S3 then honours those headers under real
 * contention is task 6.2's human-gated check against a real account, and deliberately not
 * simulated here: a fake that agreed with our assumptions would prove only that we are
 * consistent with ourselves.
 */

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function recorder(respond: (call: Recorded) => Response): {
  fetch: typeof globalThis.fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

const CREDENTIALS = {
  accessKeyId: 'ASIAEXAMPLEEXAMPLE12',
  secretAccessKey: 'notarealsecretnotarealsecretnotareal1234',
  sessionToken: 'session-token-from-the-oidc-exchange',
};

function s3(
  respond: (call: Recorded) => Response,
  options: { maxAttempts?: number } = {},
): { store: S3Store; calls: Recorded[] } {
  const { fetch, calls } = recorder(respond);
  const store = new S3Store({
    bucket: 'skyhook-acme-widgets',
    region: 'eu-west-1',
    credentials: CREDENTIALS,
    fetch,
    now: () => new Date('2026-08-14T12:00:00Z'),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    delay: async () => {}, // no real backoff in tests
  });
  return { store, calls };
}

function conflict(): Response {
  return new Response('<Error><Code>ConditionalRequestConflict</Code></Error>', { status: 409 });
}

// --- the conditional-write headers -----------------------------------------

test('feat-001/AC-5 a claim is a conditional create — If-None-Match: *', async () => {
  const { store, calls } = s3(() => new Response('', { status: 200, headers: { etag: '"v1"' } }));

  const outcome = await store.createIfAbsent('registry/acme/widgets/pr-482.json', '{}');

  assert.deepEqual(outcome, { ok: true, version: '"v1"' });
  assert.equal(calls[0]?.method, 'PUT');
  assert.equal(
    calls[0]?.headers['if-none-match'],
    '*',
    'without this header the write is not a claim at all',
  );
});

test('feat-001/AC-5 a refused conditional create is a lost race, not an error', async () => {
  const { store } = s3(() => new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 }));
  const outcome = await store.createIfAbsent('registry/acme/widgets/pr-482.json', '{}');
  assert.deepEqual(outcome, { ok: false, reason: 'already-exists' });
});

test('feat-001/AC-5 a 409 conflict is retried, not read as "already held"', async () => {
  // 412 and 409 look alike and mean opposite things. 412 says the key is occupied. 409 says
  // another writer touched the key at the same instant and S3 declined to adjudicate — nothing
  // is known. Treating it as occupied would refuse a claim for a name nobody holds, precisely
  // when the system is busiest.
  let attempt = 0;
  const { store, calls } = s3(() => {
    attempt += 1;
    return attempt < 3 ? conflict() : new Response('', { status: 200, headers: { etag: '"v1"' } });
  });

  const outcome = await store.createIfAbsent('registry/acme/widgets/pr-482.json', '{}');

  assert.deepEqual(outcome, { ok: true, version: '"v1"' }, 'the claim succeeds on retry');
  assert.equal(calls.length, 3);
});

test('feat-001/AC-5 exhausted retries report "contended" — unknown, never "already held"', async () => {
  const { store, calls } = s3(() => conflict(), { maxAttempts: 4 });

  const outcome = await store.createIfAbsent('registry/acme/widgets/pr-482.json', '{}');

  assert.deepEqual(outcome, { ok: false, reason: 'contended' });
  assert.notEqual(
    outcome.ok === false ? outcome.reason : '',
    'already-exists',
    'a name that may be free must never be reported as taken',
  );
  assert.equal(calls.length, 4, 'the retry budget is bounded');
});

test('feat-001/AC-6 a 409 on a conditional replace is retried with the same condition', async () => {
  // Retrying is safe because the same If-Match is re-sent: a repeat either lands once or is
  // refused for the real reason. It can never apply the write twice.
  let attempt = 0;
  const { store, calls } = s3(() => {
    attempt += 1;
    return attempt < 2 ? conflict() : new Response('', { status: 200, headers: { etag: '"v2"' } });
  });

  const outcome = await store.compareAndSwap('registry/acme/widgets/staging.json', '{}', '"v1"');

  assert.deepEqual(outcome, { ok: true, version: '"v2"' });
  assert.ok(calls.every((c) => c.headers['if-match'] === '"v1"'), 'every retry carries the condition');
});

test('feat-001/AC-6 a 412 on a conditional replace is not retried — it is an answer', async () => {
  const { store, calls } = s3(() => new Response('', { status: 412 }));
  const outcome = await store.compareAndSwap('registry/acme/widgets/staging.json', '{}', '"v1"');
  assert.deepEqual(outcome, { ok: false, reason: 'version-mismatch' });
  assert.equal(calls.length, 1, 'a definite refusal is never retried into succeeding');
});

test('feat-001/AC-6 an update is a conditional replace — If-Match: <version>', async () => {
  const { store, calls } = s3(() => new Response('', { status: 200, headers: { etag: '"v2"' } }));

  const outcome = await store.compareAndSwap('registry/acme/widgets/staging.json', '{}', '"v1"');

  assert.deepEqual(outcome, { ok: true, version: '"v2"' });
  assert.equal(calls[0]?.headers['if-match'], '"v1"');
});

test('feat-001/AC-6 a stale conditional replace is refused, and nothing was sent twice', async () => {
  const { store, calls } = s3(() => new Response('', { status: 412 }));
  const outcome = await store.compareAndSwap('registry/acme/widgets/staging.json', '{}', '"v1"');
  assert.deepEqual(outcome, { ok: false, reason: 'version-mismatch' });
  assert.equal(calls.length, 1, 'a refused write is not retried into succeeding');
});

test('s3: an object deleted since the read is also a lost race, not a create', async () => {
  const { store } = s3(() => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
  const outcome = await store.compareAndSwap('registry/acme/widgets/staging.json', '{}', '"v1"');
  assert.deepEqual(outcome, { ok: false, reason: 'version-mismatch' });
});

// --- missing bucket vs missing key ------------------------------------------

test('feat-001/AC-4 a missing bucket is told apart from a missing key', async () => {
  const noSuchBucket = () =>
    new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
  const noSuchKey = () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });

  const missingBucket = s3(noSuchBucket);
  assert.deepEqual(await missingBucket.store.read('registry/acme/widgets/staging.json'), {
    ok: false,
    reason: 'container-missing',
  });

  const missingKey = s3(noSuchKey);
  assert.deepEqual(await missingKey.store.read('registry/acme/widgets/staging.json'), {
    ok: true,
    object: null,
  });
});

// --- listing ----------------------------------------------------------------

test('s3: listing follows continuation tokens rather than truncating', async () => {
  // A silently truncated page would undercount active environments and let the cap be exceeded.
  let page = 0;
  const { store, calls } = s3(() => {
    page += 1;
    if (page === 1) {
      return new Response(
        '<ListBucketResult><Contents><Key>registry/acme/widgets/a.json</Key></Contents>' +
          '<NextContinuationToken>more</NextContinuationToken></ListBucketResult>',
        { status: 200 },
      );
    }
    return new Response(
      '<ListBucketResult><Contents><Key>registry/acme/widgets/b.json</Key></Contents></ListBucketResult>',
      { status: 200 },
    );
  });

  const outcome = await store.list('registry/acme/widgets/');

  assert.deepEqual(outcome, {
    ok: true,
    keys: ['registry/acme/widgets/a.json', 'registry/acme/widgets/b.json'],
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.url ?? '', /continuation-token=more/);
});

test('s3: a delete of a key that is not there still succeeds', async () => {
  // S3 answers a delete with 204 whether or not the key was there, so the postcondition the
  // caller asked for already holds and there is nothing to special-case.
  const { store } = s3(() => new Response(null, { status: 204 }));
  assert.deepEqual(await store.delete('registry/acme/widgets/gone.json'), { ok: true });
});

test('s3: an unexpected failure is loud, never swallowed', async () => {
  const { store } = s3(() => new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }));
  await assert.rejects(() => store.createIfAbsent('k', '{}'), /500/);
});

// --- signing ----------------------------------------------------------------

test('sigv4: every request carries a signature, the payload hash, and the session token', async () => {
  const { store, calls } = s3(() => new Response('', { status: 200, headers: { etag: '"v1"' } }));
  await store.createIfAbsent('registry/acme/widgets/pr-482.json', '{"a":1}');

  const headers = calls[0]?.headers ?? {};
  assert.match(headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/);
  assert.match(headers['authorization'] ?? '', /SignedHeaders=[a-z0-9;-]+/);
  assert.match(headers['x-amz-date'] ?? '', /^\d{8}T\d{6}Z$/);
  assert.equal(headers['x-amz-security-token'], CREDENTIALS.sessionToken);
  // The payload hash covers the body, so a tampered body is a rejected request.
  assert.match(headers['x-amz-content-sha256'] ?? '', /^[0-9a-f]{64}$/);
});

test('sigv4: the signature covers the body — a different body signs differently', () => {
  const base = {
    method: 'PUT',
    path: '/registry/acme/widgets/pr-482.json',
    query: {},
    headers: {},
    region: 'eu-west-1',
    service: 's3',
    host: 'skyhook-acme-widgets.s3.eu-west-1.amazonaws.com',
  };
  const at = new Date('2026-08-14T12:00:00Z');

  const one = signRequest({ ...base, body: '{"a":1}' }, CREDENTIALS, at)['authorization'];
  const other = signRequest({ ...base, body: '{"a":2}' }, CREDENTIALS, at)['authorization'];
  assert.notEqual(one, other);
});

test('sigv4: the signature covers the conditional header the claim depends on', () => {
  const base = {
    method: 'PUT',
    path: '/registry/acme/widgets/pr-482.json',
    query: {},
    body: '{}',
    region: 'eu-west-1',
    service: 's3',
    host: 'skyhook-acme-widgets.s3.eu-west-1.amazonaws.com',
  };
  const at = new Date('2026-08-14T12:00:00Z');

  const conditional = signRequest({ ...base, headers: { 'if-none-match': '*' } }, CREDENTIALS, at);
  const unconditional = signRequest({ ...base, headers: {} }, CREDENTIALS, at);

  assert.match(conditional['authorization'] ?? '', /SignedHeaders=[^,]*if-none-match/);
  assert.notEqual(conditional['authorization'], unconditional['authorization']);
});

// --- config source ----------------------------------------------------------

test('feat-001/AC-9 config is read from the default branch, never the pull request head', async () => {
  const { fetch, calls } = recorder((call) => {
    if (call.url.endsWith('/repos/acme/widgets')) {
      return new Response(JSON.stringify({ default_branch: 'trunk' }), { status: 200 });
    }
    return new Response('storage:\n  bucket: b\n  region: r\n', { status: 200 });
  });

  const source = new GitHubConfigSource({ repository: 'acme/widgets', token: 't', fetch });
  const outcome = await source.fetch();

  assert.deepEqual(outcome, { ok: true, document: 'storage:\n  bucket: b\n  region: r\n' });

  const contentsCall = calls.find((c) => c.url.includes('/contents/'));
  assert.ok(contentsCall !== undefined);
  assert.match(contentsCall.url, /ref=trunk/, 'pinned to the default branch');
  assert.doesNotMatch(contentsCall.url, /refs%2Fpull|head|merge/i);
});

test('feat-001/AC-9 the default branch is asked of GitHub, not taken from the caller', async () => {
  // If the branch were a parameter, a pull-request run's workflow — which the pull request
  // author controls — could name its own branch and be believed.
  const { fetch, calls } = recorder((call) => {
    if (call.url.endsWith('/repos/acme/widgets')) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    return new Response('storage:\n  bucket: b\n  region: r\n', { status: 200 });
  });

  await new GitHubConfigSource({ repository: 'acme/widgets', token: 't', fetch }).fetch();

  assert.ok(
    calls.some((c) => c.url.endsWith('/repos/acme/widgets')),
    'the repository is queried for its default branch',
  );
});

test('config source: an absent config file is reported as absent, not as a failure', async () => {
  const { fetch } = recorder((call) =>
    call.url.endsWith('/repos/acme/widgets')
      ? new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      : new Response('', { status: 404 }),
  );
  const outcome = await new GitHubConfigSource({ repository: 'acme/widgets', token: 't', fetch }).fetch();
  assert.deepEqual(outcome, { ok: true, document: null });
});

test('config source: an unreadable repository is a problem, never a silent default', async () => {
  const { fetch } = recorder(() => new Response('', { status: 403 }));
  const outcome = await new GitHubConfigSource({ repository: 'acme/widgets', token: 't', fetch }).fetch();
  assert.equal(outcome.ok, false);
});

// --- the subject a run presents (chg-009) -----------------------------------
//
// feat-001/AC-32 and feat-001/AC-33. Five outcomes, and the interesting ones are the four where
// GitHub does not simply answer: a trust policy is written from whatever comes back here, and a
// wrong prefix fails as an AccessDenied that names nothing. Every assertion checks the `stated`
// flag as well as the prefix, because a fallback that stopped announcing itself would pass a
// prefix-only test while removing the one thing that makes falling back acceptable.

test('feat-001/AC-32 an ID-qualified subject is taken from GitHub, not assumed', async () => {
  const { fetch, calls } = recorder(() =>
    new Response(JSON.stringify({ sub_claim_prefix: 'repo:acme@26345547/widgets@1335111920' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  const outcome = await subjectPrefix({ repository: 'acme/widgets', token: 't', fetch });

  assert.deepEqual(outcome, {
    ok: true,
    prefix: 'repo:acme@26345547/widgets@1335111920',
    stated: true,
  });
  assert.ok(
    calls.some((c) => c.url.endsWith('/repos/acme/widgets/actions/oidc/customization/sub')),
    'the repository is asked which subject its runs present',
  );
});

test('feat-001/AC-32 a repository with no customization gets the conventional form', async () => {
  const { fetch } = recorder(() => new Response(JSON.stringify({}), { status: 200 }));

  const outcome = await subjectPrefix({ repository: 'acme/widgets', token: 't', fetch });

  assert.deepEqual(outcome, { ok: true, prefix: 'repo:acme/widgets', stated: false });
});

test('feat-001/AC-33 a refusal to disclose the setting is a fallback, and says so', async () => {
  // Reading this endpoint needs repository admin, which the operator running a bootstrap usually
  // but not always has. Falling back is right wherever the conventional form applies and wrong in
  // exactly the organizations that qualify their subjects — so it is reported, never assumed.
  for (const status of [403, 404]) {
    const { fetch } = recorder(() => new Response('', { status }));

    const outcome = await subjectPrefix({ repository: 'acme/widgets', token: 't', fetch });

    assert.deepEqual(
      outcome,
      { ok: true, prefix: 'repo:acme/widgets', stated: false },
      `${status} should fall back and admit it`,
    );
  }
});

test('feat-001/AC-33 an unreadable answer is a problem, never a guess', async () => {
  const { fetch } = recorder(() => new Response('not json at all', { status: 200 }));

  const outcome = await subjectPrefix({ repository: 'acme/widgets', token: 't', fetch });

  assert.equal(outcome.ok, false);
});

test('feat-001/AC-33 an unreachable host stops the bootstrap and names the cause', async () => {
  const fetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  }) as unknown as typeof globalThis.fetch;

  const outcome = await subjectPrefix({ repository: 'acme/widgets', token: 't', fetch });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  // The cause reaches the operator. A bare "could not determine the subject" would send them
  // looking at their GitHub permissions for a DNS failure.
  assert.match(outcome.problem, /ENOTFOUND/);
});

test('feat-001/AC-33 an unexpected status is reported rather than folded into the fallback', async () => {
  const { fetch } = recorder(() => new Response('', { status: 500 }));

  const outcome = await subjectPrefix({ repository: 'acme/widgets', token: 't', fetch });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.problem, /500/);
});
