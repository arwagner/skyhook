/**
 * `Store` over S3's conditional writes.
 *
 * This is the whole bet the feature rests on. Claiming an environment is `PutObject` with
 * `If-None-Match: *`, which succeeds only if no object exists at that key — mutual exclusion on
 * a name, in one operation, with no lock and no read-modify-write loop. Updating a record is
 * `PutObject` with `If-Match: <etag>`, which fails if anything changed since the read.
 *
 * Whether real S3 honours those headers under real contention is exactly what the prototype's
 * human-gated verification exists to find out (task 6.2). Everything above this file is tested
 * against a fake that *implements* these semantics, which proves the logic is right **given**
 * that S3 behaves as assumed. If it does not, the S3-only decision does not survive.
 */

import type {
  CreateOutcome,
  DeleteOutcome,
  ListOutcome,
  ReadOutcome,
  Store,
  SwapOutcome,
  VersionToken,
} from '../../core/store.ts';
import { signRequest, uriEncode, type Credentials } from './sigv4.ts';

export interface S3StoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly credentials: Credentials;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests, so a signature is reproducible. */
  readonly now?: () => Date;
  /** Overrides the endpoint host. For a local S3 stand-in. */
  readonly host?: string;
  /** How many times a conditional write is attempted before reporting `contended`. */
  readonly maxAttempts?: number;
  /** Injected for tests, so retries do not make the suite slow. */
  readonly delay?: (milliseconds: number) => Promise<void>;
}

const CONTAINER_MISSING = { ok: false, reason: 'container-missing' } as const;
const CONTENDED = { ok: false, reason: 'contended' } as const;

/**
 * 412 and 409 look alike and mean opposite things.
 *
 * **412 Precondition Failed** is an answer: the object is there (or is not the one you read), so
 * your conditional write genuinely lost. **409 ConditionalRequestConflict** is not an answer — it
 * means another request touched this key at the same moment and S3 declined to adjudicate. Nothing
 * is known about whether the key is occupied.
 *
 * Reading a 409 as "already exists" would refuse a claim for a name nobody holds, and it would do
 * so exactly when the system is busiest. So a 409 is retried, and only an exhausted retry budget
 * produces `contended` — which says "unknown, try again", not "taken".
 */
const PRECONDITION_FAILED = 412;
const CONDITIONAL_CONFLICT = 409;

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 1_000;

/** Returned by an attempt that established nothing and should be repeated. */
const RETRY = Symbol('retry');

export class S3Store implements Store {
  readonly #bucket: string;
  readonly #region: string;
  readonly #credentials: Credentials;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #host: string;
  readonly #maxAttempts: number;
  readonly #delay: (milliseconds: number) => Promise<void>;

  constructor(options: S3StoreOptions) {
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#host = options.host ?? `${options.bucket}.s3.${options.region}.amazonaws.com`;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async createIfAbsent(key: string, value: string): Promise<CreateOutcome> {
    // `If-None-Match: *` — write only if nothing is at this key.
    return this.#retrying<CreateOutcome>(CONTENDED, async () => {
      const response = await this.#send('PUT', key, {}, value, { 'if-none-match': '*' });
      if (response.status === CONDITIONAL_CONFLICT) return await conflict(response);
      if (response.status === 404 && (await isNoSuchBucket(response))) return CONTAINER_MISSING;
      if (response.status === PRECONDITION_FAILED) return { ok: false, reason: 'already-exists' };
      if (!response.ok) throw await failure('createIfAbsent', key, response);
      return { ok: true, version: etagOf(response) };
    });
  }

  async read(key: string): Promise<ReadOutcome> {
    const response = await this.#send('GET', key, {}, '');
    if (response.status === 404) {
      return (await isNoSuchBucket(response)) ? CONTAINER_MISSING : { ok: true, object: null };
    }
    if (!response.ok) throw await failure('read', key, response);
    return { ok: true, object: { value: await response.text(), version: etagOf(response) } };
  }

  async compareAndSwap(key: string, value: string, expected: VersionToken): Promise<SwapOutcome> {
    // `If-Match: <etag>` — write only if the object is still the one that was read. Retrying is
    // safe: the same condition is re-sent, so a repeat either lands once or is refused for the
    // real reason. It can never apply the write twice.
    return this.#retrying<SwapOutcome>(CONTENDED, async () => {
      const response = await this.#send('PUT', key, {}, value, { 'if-match': expected });
      if (response.status === CONDITIONAL_CONFLICT) return await conflict(response);
      if (response.status === 404 && (await isNoSuchBucket(response))) return CONTAINER_MISSING;
      // 404 on the object means it was deleted since the read, which is also a lost race.
      if (response.status === 404 || response.status === PRECONDITION_FAILED) {
        return { ok: false, reason: 'version-mismatch' };
      }
      if (!response.ok) throw await failure('compareAndSwap', key, response);
      return { ok: true, version: etagOf(response) };
    });
  }

  /**
   * Repeats an attempt that reported it established nothing, backing off with full jitter so two
   * colliding writers do not march back into each other in lockstep. Returns `exhausted` when the
   * budget runs out — an honest "unknown", never a guess about the key's state.
   */
  async #retrying<T>(exhausted: T, attempt: () => Promise<T | typeof RETRY>): Promise<T> {
    for (let index = 0; index < this.#maxAttempts; index += 1) {
      const outcome = await attempt();
      if (outcome !== RETRY) return outcome;
      if (index < this.#maxAttempts - 1) await this.#delay(backoffFor(index));
    }
    return exhausted;
  }

  async list(prefix: string): Promise<ListOutcome> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (continuationToken !== undefined) query['continuation-token'] = continuationToken;

      const response = await this.#send('GET', '', query, '');
      if (response.status === 404) return CONTAINER_MISSING;
      if (!response.ok) throw await failure('list', prefix, response);

      const body = await response.text();
      keys.push(...parseKeys(body));
      continuationToken = parseTag(body, 'NextContinuationToken');
      // Paging matters: the cap is counted from this list, and a silently truncated page
      // would undercount active environments and let the cap be exceeded.
    } while (continuationToken !== undefined);

    return { ok: true, keys: keys.sort() };
  }

  async delete(key: string): Promise<DeleteOutcome> {
    const response = await this.#send('DELETE', key, {}, '');
    if (response.status === 404 && (await isNoSuchBucket(response))) return CONTAINER_MISSING;
    // S3 reports success for deleting a key that is not there, which is the postcondition asked
    // for, so no special case is needed.
    if (!response.ok && response.status !== 404) throw await failure('delete', key, response);
    return { ok: true };
  }

  async #send(
    method: string,
    key: string,
    query: Readonly<Record<string, string>>,
    body: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const path = `/${uriEncode(key, true)}`;
    const headers = signRequest(
      {
        method,
        path,
        query,
        headers: {
          ...extraHeaders,
          ...(body === '' ? {} : { 'content-type': 'application/json' }),
        },
        body,
        region: this.#region,
        service: 's3',
        host: this.#host,
      },
      this.#credentials,
      this.#now(),
    );

    const search = new URLSearchParams(query).toString();
    const url = `https://${this.#host}${path}${search === '' ? '' : `?${search}`}`;

    return this.#fetch(url, {
      method,
      headers,
      ...(body === '' ? {} : { body }),
    });
  }
}

function etagOf(response: Response): VersionToken {
  const etag = response.headers.get('etag');
  if (etag === null) {
    // Without an etag there is no version to compare against later, so a subsequent
    // compare-and-swap could not be honest. Fail loudly rather than invent a token.
    throw new Error('S3 response carried no ETag; cannot produce a version token');
  }
  return etag;
}

/**
 * A 409 on a conditional write. The body is drained rather than dropped, both to free the socket
 * and so the reason is available if this ever needs diagnosing.
 */
async function conflict(response: Response): Promise<typeof RETRY> {
  await response.text().catch(() => '');
  return RETRY;
}

/** Full jitter: the delay is uniform in [0, capped exponential], not the exponential itself. */
function backoffFor(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

async function isNoSuchBucket(response: Response): Promise<boolean> {
  const body = await response.clone().text();
  return body.includes('<Code>NoSuchBucket</Code>');
}

async function failure(operation: string, target: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  // Loud, with the status and whatever S3 said. Nothing swallows an error to keep a run green:
  // for this product a silent failure and a success look alike until the bill arrives.
  return new Error(
    `S3 ${operation} failed for "${target}": ${response.status} ${response.statusText} ${body}`.trim(),
  );
}

/**
 * Minimal XML reading. The `ListObjectsV2` response is a flat, well-known shape and skyhook only
 * ever needs the keys and the continuation token, so a parser dependency would buy nothing here.
 * Keys are XML-escaped by S3, so the entities it can emit are un-escaped on the way out.
 */
function parseKeys(xml: string): string[] {
  return [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => unescapeXml(match[1] ?? ''));
}

function parseTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match === null ? undefined : unescapeXml(match[1] ?? '');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
