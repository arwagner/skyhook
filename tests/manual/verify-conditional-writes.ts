/**
 * hs-1 / task 6.2 — THE MUST-PROVE.
 *
 * Everything above the storage seam is tested against a double that *implements* conditional-write
 * semantics. That proves skyhook's logic is right **given** S3 behaves as assumed. This script is
 * the other half: it runs the real `S3Store` and the real `Registry` against a real bucket, under
 * genuine concurrency, and checks the assumption itself.
 *
 * It deliberately drives the production classes rather than issuing its own requests. A script that
 * reimplemented the calls would prove S3 works and tell you nothing about whether skyhook uses it
 * correctly — and the adapter is exactly where that could go wrong.
 *
 * NOT part of the automated suite (it needs a real account and costs real requests). It does not
 * match the `tests/**\/*.test.ts` glob, so `npm test` will not pick it up.
 *
 * Usage:
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... [AWS_SESSION_TOKEN=...] \
 *     node tests/manual/verify-conditional-writes.ts --bucket <name> --region <region> \
 *       [--rounds 50] [--concurrency 5]
 */

import { parseArgs } from 'node:util';
import { S3Store } from '../../src/adapters/aws/s3-store.ts';
import { Registry } from '../../src/core/registry.ts';

const { values } = parseArgs({
  options: {
    bucket: { type: 'string' },
    region: { type: 'string' },
    rounds: { type: 'string', default: '50' },
    concurrency: { type: 'string', default: '5' },
    repository: { type: 'string', default: 'skyhook/verification' },
  },
});

const bucket = required(values.bucket, '--bucket');
const region = required(values.region, '--region');
const rounds = Number.parseInt(values.rounds ?? '50', 10);
const concurrency = Number.parseInt(values.concurrency ?? '5', 10);
const repository = values.repository ?? 'skyhook/verification';

const store = new S3Store({
  bucket,
  region,
  credentials: {
    accessKeyId: required(process.env['AWS_ACCESS_KEY_ID'], 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: required(process.env['AWS_SECRET_ACCESS_KEY'], 'AWS_SECRET_ACCESS_KEY'),
    sessionToken: process.env['AWS_SESSION_TOKEN'],
  },
});
const registry = new Registry(store);

interface Tally {
  rounds: number;
  exactlyOneWinner: number;
  noWinner: number;
  multipleWinners: number;
  lostUpdate: number;
  loserReasons: Map<string, number>;
}

const claims: Tally = blank();
const swaps: Tally = blank();

function blank(): Tally {
  return {
    rounds: 0,
    exactlyOneWinner: 0,
    noWinner: 0,
    multipleWinners: 0,
    lostUpdate: 0,
    loserReasons: new Map(),
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
}

function count(tally: Tally, reason: string): void {
  tally.loserReasons.set(reason, (tally.loserReasons.get(reason) ?? 0) + 1);
}

const runId = `v${Date.now().toString(36)}`;

async function main(): Promise<void> {
  // Warm the connection pool first. Otherwise the first round's TLS handshake staggers the
  // requests and the "concurrent" round is not concurrent at all — which would make the whole
  // exercise pass for the wrong reason.
  await store.read(`registry/${repository}/warmup.json`);

  console.log(`bucket=${bucket} region=${region} rounds=${rounds} concurrency=${concurrency}\n`);

  for (let round = 0; round < rounds; round += 1) {
    const identity = `${runId}-${round}`;

    // --- claim: N concurrent create-if-absent on one key ---------------------
    const outcomes = await Promise.all(
      Array.from({ length: concurrency }, () => registry.claim({ repository, identity })),
    );
    const winners = outcomes.filter((o) => o.ok);
    claims.rounds += 1;
    for (const outcome of outcomes) if (!outcome.ok) count(claims, outcome.reason);

    if (winners.length === 1) claims.exactlyOneWinner += 1;
    else if (winners.length === 0) {
      claims.noWinner += 1;
      console.log(`  round ${round}: NO WINNER — every claim was refused, nothing was written`);
    } else {
      claims.multipleWinners += 1;
      console.log(`  round ${round}: ${winners.length} WINNERS — the claim is not exclusive`);
    }

    // Whoever won, the stored record must be theirs and the key must exist.
    const stored = await registry.read(repository, identity);
    if (!stored.ok || stored.record === null) {
      if (winners.length > 0) {
        console.log(`  round ${round}: a claim reported success but no record is stored`);
        claims.lostUpdate += 1;
      }
      await registry.remove(repository, identity);
      continue;
    }

    // --- compare-and-swap: N concurrent updates from one version -------------
    const version = stored.version;
    const swapOutcomes = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        registry.update(repository, identity, version, { deployedCommit: `commit-${index}` }),
      ),
    );
    const swapWinners = swapOutcomes.filter((o) => o.ok);
    swaps.rounds += 1;
    for (const outcome of swapOutcomes) if (!outcome.ok) count(swaps, outcome.reason);

    if (swapWinners.length === 1) swaps.exactlyOneWinner += 1;
    else if (swapWinners.length === 0) swaps.noWinner += 1;
    else {
      swaps.multipleWinners += 1;
      console.log(`  round ${round}: ${swapWinners.length} concurrent updates both landed`);
    }

    // No lost update: what is stored must be what some winner wrote, not a blend or a straggler.
    const after = await registry.read(repository, identity);
    if (after.ok && after.record !== null && swapWinners.length > 0) {
      const claimed = swapWinners.map((o) => (o.ok ? o.record.deployedCommit : null));
      if (!claimed.includes(after.record.deployedCommit)) {
        swaps.lostUpdate += 1;
        console.log(`  round ${round}: stored commit ${after.record.deployedCommit} was written by no winner`);
      }
    }

    await registry.remove(repository, identity);
  }

  report('CLAIM  (If-None-Match: *)', claims);
  report('UPDATE (If-Match: <etag>)', swaps);
  verdict();
}

function report(title: string, tally: Tally): void {
  console.log(`\n${title}`);
  console.log(`  rounds:              ${tally.rounds}`);
  console.log(`  exactly one winner:  ${tally.exactlyOneWinner}`);
  console.log(`  NO winner:           ${tally.noWinner}`);
  console.log(`  MULTIPLE winners:    ${tally.multipleWinners}`);
  console.log(`  lost update:         ${tally.lostUpdate}`);
  console.log(`  refusal reasons:     ${[...tally.loserReasons].map(([r, n]) => `${r}=${n}`).join(' ') || '—'}`);
}

function verdict(): void {
  const fatal =
    claims.multipleWinners > 0 || swaps.multipleWinners > 0 || claims.lostUpdate > 0 || swaps.lostUpdate > 0;
  const suspicious = claims.noWinner > 0 || swaps.noWinner > 0;

  console.log('\n' + '='.repeat(72));
  if (fatal) {
    console.log('FAILED. Conditional writes did not give mutual exclusion.');
    console.log('D2 does not survive: two runs can act on one environment. Raise this — do not');
    console.log('work around it. The S3-only decision needs revisiting.');
    process.exitCode = 1;
    return;
  }
  if (suspicious) {
    console.log('INCONCLUSIVE — mutual exclusion held, but some rounds produced no winner at all.');
    console.log('');
    console.log('Check the refusal reasons above. `contended` means the adapter exhausted its');
    console.log('retry budget against repeated 409 ConditionalRequestConflict — S3 declining to');
    console.log('adjudicate rather than saying the key is taken. That is safe (nobody wrongly');
    console.log('claimed a name) but it is a liveness problem: raise --concurrency and see');
    console.log('whether it worsens, then consider a larger maxAttempts on S3Store.');
    console.log('');
    console.log('If instead the reasons are `held` or `awaiting-teardown` with no winner, that is');
    console.log('more serious: every claim was told the name is taken while nothing was stored.');
    process.exitCode = 1;
    return;
  }
  console.log('PASSED. Every round had exactly one winner, and no write was silently discarded.');
  console.log('D2 holds: S3 conditional writes give atomic claims under real contention.');
  console.log('Record this against hs-1 in spec/features/backing-store/feature.md.');
}

await main();
