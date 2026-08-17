import type { DeployConfig, EnvironmentCap, SkyhookConfig, StorageConfig } from './types.ts';
import { parseYamlSubset, type YamlMap, type YamlValue } from './yaml.ts';

/**
 * The environment cap is enabled by default with a limit of 5, and may be disabled
 * entirely (product-global, cross-cutting constraints).
 */
export const DEFAULT_ENVIRONMENT_CAP: EnvironmentCap = { enabled: true, limit: 5 };

export const CONFIG_PATH = '.skyhook/config.yml';

export type ConfigOutcome =
  | { readonly ok: true; readonly config: SkyhookConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

export type ConfigFetchOutcome =
  /** `document` is null when the consuming repo has no config file at all. */
  | { readonly ok: true; readonly document: string | null }
  | { readonly ok: false; readonly problem: string };

/**
 * Where the config document comes from. This is the seam, and the only one:
 * a pull-request run must read settings from the repository's **default branch**,
 * never from the checked-out working tree, because a pull-request run checks out
 * the pull request's own code and reading from disk would read the attacker's copy
 * (plan D5, AC-9). Keeping the read location behind one interface is also what makes
 * "let a pull request override its own settings" a later implementation rather than
 * a refactor.
 */
export interface ConfigSource {
  fetch(): Promise<ConfigFetchOutcome>;
}

export async function loadConfig(source: ConfigSource): Promise<ConfigOutcome> {
  const fetched = await source.fetch();
  if (!fetched.ok) return { ok: false, problems: [fetched.problem] };
  return parseConfig(fetched.document);
}

export function parseConfig(document: string | null): ConfigOutcome {
  if (document === null) {
    return { ok: false, problems: [`no ${CONFIG_PATH} found in the repository`] };
  }
  const parsed = parseYamlSubset(document);
  if (!parsed.ok) return { ok: false, problems: parsed.problems };

  const problems: string[] = [];
  const root = parsed.value;
  rejectUnknownKeys(root, ['storage', 'environment_cap', 'deploy'], '', problems);

  const storage = readStorage(root['storage'], problems);
  const environmentCap = readCap(root['environment_cap'], problems);
  const deploy = readDeploy(root['deploy'], problems);

  if (problems.length > 0 || storage === null) return { ok: false, problems };
  return { ok: true, config: { storage, environmentCap, deploy } };
}

/** The default role name prefix, matching the bootstrap's own `name_prefix` default. */
export const DEFAULT_ROLE_PREFIX = 'skyhook';

/**
 * Absent means "this installation does not deploy", not "use defaults".
 *
 * Present-but-incomplete is an error: skyhook cannot guess where a repository keeps its
 * infrastructure, and guessing would mean applying the wrong directory with credentials
 * that create real resources.
 */
function readDeploy(value: YamlValue | undefined, problems: string[]): DeployConfig | null {
  if (value === undefined) return null;
  if (!isMap(value)) {
    problems.push('deploy: expected a block of settings');
    return null;
  }
  rejectUnknownKeys(
    value,
    ['directory', 'role_prefix', 'inputs', 'allow_sensitive_input_names'],
    'deploy.',
    problems,
  );

  const directory = readRequiredString(value['directory'], 'deploy.directory', problems);
  const rawPrefix = value['role_prefix'];
  let rolePrefix = DEFAULT_ROLE_PREFIX;
  if (rawPrefix !== undefined) {
    if (typeof rawPrefix !== 'string' || rawPrefix.trim() === '') {
      problems.push('deploy.role_prefix: expected a non-empty string');
    } else {
      rolePrefix = rawPrefix;
    }
  }

  const inputs = readInputs(value['inputs'], value['allow_sensitive_input_names'], problems);

  if (directory === null) return null;
  return { directory, rolePrefix, inputs };
}

/** The most names one repository may declare (AC-35). Mirrors AC-20's identity-length pattern: a bound refused where it is supplied. */
const MAX_DECLARED_INPUTS = 16;

/**
 * The generic identifier class, deliberately not any one tool's full grammar: core stays
 * provider-agnostic, and a name a tool additionally reserves is that tool's own loud
 * refusal at first use (chg-011, the gap-001 lesson).
 */
const INPUT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/**
 * Defense-in-depth beside the settings file's warning, not the boundary: a declared
 * value is recorded in the registry in the clear, so a name that says it holds a secret
 * is refused unless the operator names it as an exception, per name, where a reviewer
 * sees it (AC-35).
 */
const SENSITIVE_FRAGMENTS = ['secret', 'password', 'token', 'key', 'credential'];

function readInputs(
  value: YamlValue | undefined,
  rawExceptions: YamlValue | undefined,
  problems: string[],
): readonly string[] {
  const exceptions = readNameList(rawExceptions, 'deploy.allow_sensitive_input_names', problems);
  if (value === undefined) {
    for (const name of exceptions) {
      problems.push(
        `deploy.allow_sensitive_input_names: "${name}" names no declared input — likely a typo`,
      );
    }
    return [];
  }
  const names = readNameList(value, 'deploy.inputs', problems);
  if (names.length > MAX_DECLARED_INPUTS) {
    problems.push(
      `deploy.inputs: ${names.length} names declared, at most ${MAX_DECLARED_INPUTS} are supported`,
    );
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      problems.push(`deploy.inputs: "${name}" is declared twice`);
      continue;
    }
    seen.add(name);
    if (!INPUT_NAME_PATTERN.test(name)) {
      problems.push(
        `deploy.inputs: "${name}" is not a valid input name — a letter or "_" first, then letters, digits, "_" or "-"`,
      );
      continue;
    }
    const lowered = name.toLowerCase();
    const fragment = SENSITIVE_FRAGMENTS.find((f) => lowered.includes(f));
    if (fragment !== undefined && !exceptions.includes(name)) {
      problems.push(
        `deploy.inputs: "${name}" looks like it names a secret ("${fragment}"). Recorded values ` +
          'are stored in the registry in the clear — if this input truly carries no secret, ' +
          'list the exact name under deploy.allow_sensitive_input_names',
      );
    }
  }
  for (const name of exceptions) {
    if (!seen.has(name)) {
      problems.push(
        `deploy.allow_sensitive_input_names: "${name}" names no declared input — likely a typo`,
      );
    }
  }
  return [...seen];
}

/** A flat list of strings, or problems. Non-strings are refused, never coerced. */
function readNameList(value: YamlValue | undefined, path: string, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${path}: expected a list of names ("- name" lines)`);
    return [];
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      problems.push(`${path}: expected every entry to be a name, got ${JSON.stringify(item)}`);
      continue;
    }
    names.push(item);
  }
  return names;
}

function readStorage(value: YamlValue | undefined, problems: string[]): StorageConfig | null {
  if (value === undefined) {
    problems.push('storage: required — name the bucket the bootstrap Terraform declares');
    return null;
  }
  if (!isMap(value)) {
    problems.push('storage: expected a block of settings');
    return null;
  }
  rejectUnknownKeys(value, ['bucket', 'region', 'account'], 'storage.', problems);
  const bucket = readRequiredString(value['bucket'], 'storage.bucket', problems);
  const region = readRequiredString(value['region'], 'storage.region', problems);

  // Optional, because installations predate it. A deploy names it as missing rather than
  // deriving a role identifier from nothing; every other command never looks.
  const rawAccount = value['account'];
  let account: string | null = null;
  if (rawAccount !== undefined) {
    if (typeof rawAccount === 'number') {
      // A bare 123456789012 in YAML is a number, and a leading zero would already be lost
      // by the time it got here. Refusing it names the fix instead of deriving a role
      // identifier from a mangled account.
      problems.push('storage.account: quote it — an unquoted account id is read as a number');
    } else if (typeof rawAccount !== 'string' || rawAccount.trim() === '') {
      problems.push('storage.account: expected a non-empty string');
    } else {
      account = rawAccount;
    }
  }

  if (bucket === null || region === null) return null;
  return { bucket, region, account };
}

function readCap(value: YamlValue | undefined, problems: string[]): EnvironmentCap {
  if (value === undefined) return DEFAULT_ENVIRONMENT_CAP;
  if (!isMap(value)) {
    problems.push('environment_cap: expected a block of settings');
    return DEFAULT_ENVIRONMENT_CAP;
  }
  rejectUnknownKeys(value, ['enabled', 'limit'], 'environment_cap.', problems);

  const rawEnabled = value['enabled'];
  let enabled = DEFAULT_ENVIRONMENT_CAP.enabled;
  if (rawEnabled !== undefined) {
    if (typeof rawEnabled !== 'boolean') {
      problems.push('environment_cap.enabled: expected true or false');
    } else {
      enabled = rawEnabled;
    }
  }

  const rawLimit = value['limit'];
  let limit = DEFAULT_ENVIRONMENT_CAP.limit;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
      problems.push('environment_cap.limit: expected a whole number of 1 or more');
    } else {
      limit = rawLimit;
    }
  }

  return { enabled, limit };
}

function readRequiredString(
  value: YamlValue | undefined,
  path: string,
  problems: string[],
): string | null {
  if (value === undefined) {
    problems.push(`${path}: required`);
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${path}: expected a non-empty string`);
    return null;
  }
  return value;
}

/**
 * An unrecognized key is an error, not something to ignore. This file gates the
 * environment cap; a typo silently falling back to the default is the difference
 * between a cap of 20 and a cap of 5, and nobody would notice until the bill arrived.
 */
function rejectUnknownKeys(
  map: YamlMap,
  allowed: readonly string[],
  prefix: string,
  problems: string[],
): void {
  for (const key of Object.keys(map)) {
    if (!allowed.includes(key)) problems.push(`${prefix}${key}: unrecognized setting`);
  }
}

function isMap(value: YamlValue): value is YamlMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
