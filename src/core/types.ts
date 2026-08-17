/**
 * Core domain types. Provider-agnostic by construction: nothing in `src/core/`
 * may name S3, AWS, or Terraform (constitution, "provider-agnostic core"; plan D6).
 */

/** A deployed copy of a consuming repo's infrastructure is in exactly one state. */
export type EnvironmentState =
  /**
   * Skyhook's own, built or being built ahead of any pull request, belonging to nobody
   * yet (feat-007, chg-012). Claimable once its record carries a deployed commit; only
   * pooling creates one, and an installation with pooling off never holds one.
   */
  | 'warm'
  /** In use. Must not be destroyed. */
  | 'active'
  /** Eligible for teardown. The infrastructure may still be standing. */
  | 'released';

/**
 * The registry's record of one environment.
 *
 * A record exists for exactly as long as its environment does: teardown deletes it,
 * and that deletion is what frees the identity for reuse (plan D2b).
 *
 * There is deliberately **no `protected` field here.** Protection lives at its own
 * key so a bucket policy can refuse the write, and a bucket policy can restrict which
 * keys a role writes but cannot inspect what is inside one (plan D2a, AC-15).
 * A record found carrying a stray `protected` field is ignored, never honored.
 */
export interface EnvironmentRecord {
  /** The consuming repo this environment belongs to, as `owner/name`. */
  readonly repository: string;
  /** Names one environment within its repository: `staging`, `pr-482`. */
  readonly identity: string;
  readonly state: EnvironmentState;
  /** The commit currently deployed, or null before the first deploy lands. */
  readonly deployedCommit: string | null;
  /**
   * Where this environment is reachable, or null before an address is known — which is
   * every record between being claimed and its first successful deploy, since the record
   * is written before the infrastructure exists (feat-002 plan D7).
   *
   * Additive: a record written before this field existed reads back with null rather than
   * being rejected. Refusing it would strand every environment the prototype has already
   * recorded, and the registry is the only thing that knows they need tearing down.
   */
  readonly url: string | null;
  /**
   * The recorded values of the repository's declared deploy inputs — name to value — or
   * null before a deploy that declared any has landed (chg-011, AC-36). Updated exactly
   * when `deployedCommit` is, as a wholesale replace, so the values and the commit
   * always describe the same landed deploy.
   *
   * Additive like `url`: a record written before this field existed reads back with
   * null, and every reader treats that as "none recorded".
   */
  readonly deployInputs: Readonly<Record<string, string>> | null;
  /**
   * The pull request that claimed this warm slot, or null everywhere else (feat-007,
   * chg-012 AC-39). For a pooled environment the claimant — never the identity — says
   * which pull request owns it; for every other environment the identity already does.
   *
   * Additive like `url`: records written before the field existed read back with null.
   */
  readonly claimant: number | null;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  /** ISO-8601 UTC. */
  readonly updatedAt: string;
}

/**
 * How many environments a consuming repo may hold at once. Enabled by default with a
 * limit of 5, and may be disabled entirely (product-global, cross-cutting constraints).
 */
export interface EnvironmentCap {
  readonly enabled: boolean;
  readonly limit: number;
}

/** Where skyhook's own data lives. The bootstrap Terraform owns this bucket (plan D3). */
export interface StorageConfig {
  readonly bucket: string;
  readonly region: string;
  /**
   * The cloud account holding the bucket and the roles, or null if it was never recorded.
   *
   * Deliberately an opaque string: a 12-digit shape would be an AWS fact, and nothing in
   * `src/core/` may special-case a provider by name (constitution, "provider-agnostic
   * core"). The adapter that builds a role identifier from it is where that knowledge
   * belongs. Null is tolerated because installations predate this field; a deploy names
   * it as missing rather than deriving an identifier from nothing.
   */
  readonly account: string | null;
}

/**
 * What a deploy needs to know that skyhook cannot work out for itself: where the
 * consuming repo keeps its own infrastructure, and what its roles are called.
 *
 * Absent for an installation that has never deployed, which is why it is nullable rather
 * than defaulted — `bootstrap` and `destruct` predate it and must keep working untouched.
 */
export interface DeployConfig {
  /** Where the consuming repo's own infrastructure definition lives, relative to its root. */
  readonly directory: string;
  /**
   * Matches the bootstrap's `name_prefix`. Skyhook derives every role identifier from it
   * rather than reading one out of settings, so the deploy role's identity comes from the
   * repository's own declaration and never from a value typed here (plan D4).
   */
  readonly rolePrefix: string;
  /**
   * The declared deploy inputs: names of the variables a deploy carries and skyhook
   * records (chg-011, AC-35). Empty when the repository declares none. Validation —
   * shape, count, sensitivity — happened at parse time; a name in here is one a deploy
   * may read, record, and a destroy may replay.
   */
  readonly inputs: readonly string[];
}

/**
 * The warm slot pool's one setting (feat-007, od-1/od-3): how many claimable warm slots
 * the repository wants standing. Null — the whole config field — means pooling is off
 * and every pool behavior is inert; a parsed target of zero normalizes to null so
 * `pool === null` is the one off-check everywhere.
 */
export interface PoolConfig {
  readonly target: number;
}

/** The settings a consuming repo supplies in `.skyhook/config.yml`. */
export interface SkyhookConfig {
  readonly environmentCap: EnvironmentCap;
  readonly storage: StorageConfig;
  readonly deploy: DeployConfig | null;
  readonly pool: PoolConfig | null;
}
