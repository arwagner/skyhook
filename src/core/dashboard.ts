/**
 * The dashboard: one read-only page answering three questions at a glance — how close
 * the repository is to its environment cap, which slot can be freed, and what URL an
 * environment is reachable on (feat-005).
 *
 * Model building and rendering are pure so every acceptance criterion except the
 * serving one verifies here, with no store and no server. Nothing in this file may
 * name a provider (constitution, "provider-agnostic core").
 */

import type { EnvironmentCap, EnvironmentRecord } from './types.ts';

/**
 * The PR number is *derived*, not stored: the registry has no PR field, and the
 * `pr-<number>` identity shape is the deploy's naming convention, not a registry
 * guarantee. An identity that does not match renders with no PR number rather than a
 * guessed one (spec AC-1).
 */
export function pullRequestFromIdentity(identity: string): number | null {
  const match = /^pr-([1-9][0-9]*)$/.exec(identity);
  return match === null ? null : Number(match[1]);
}

export interface DashboardRow {
  readonly record: EnvironmentRecord;
  readonly pullRequest: number | null;
  readonly isProtected: boolean;
  /** Teardown may take this slot: `released` and not protected (spec AC-3). */
  readonly reclaimable: boolean;
}

export interface DashboardModel {
  readonly repository: string;
  /** Sorted by identity, so the listing is stable across loads. */
  readonly rows: readonly DashboardRow[];
  readonly cap: EnvironmentCap;
  /**
   * Record count, exactly the deploy's cap measure: a `released` environment is still
   * standing and still costs, so it still counts (feat-001's key-count semantics).
   */
  readonly used: number;
}

export function buildDashboardModel(
  repository: string,
  records: readonly EnvironmentRecord[],
  protectedIdentities: readonly string[],
  cap: EnvironmentCap,
): DashboardModel {
  const marked = new Set(protectedIdentities);
  const rows = [...records]
    .sort((a, b) => a.identity.localeCompare(b.identity))
    .map((record): DashboardRow => {
      const isProtected = marked.has(record.identity);
      return {
        record,
        // For a pooled slot the claimant — an explicitly recorded field (feat-001/AC-39) —
        // is the one sanctioned second source of a PR number (chg-002 against AC-1); any
        // identity that is neither `pr-<n>` nor a claimed slot renders with no number
        // rather than a guessed one.
        pullRequest: pullRequestFromIdentity(record.identity) ?? record.claimant,
        isProtected,
        reclaimable: record.state === 'released' && !isProtected,
      };
    });
  return { repository, rows, cap, used: rows.length };
}

// --- rendering --------------------------------------------------------------

/**
 * Record bodies are writable by pull-request-triggered runs, so every field is hostile
 * until escaped (analyze S1). Nothing from a record reaches the page unescaped, and
 * only an http(s) URL becomes a link — any other scheme renders as inert text.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const PENDING = '<em>pending</em>';

function urlCell(url: string | null): string {
  if (url === null) return PENDING;
  if (!isHttpUrl(url)) return escapeHtml(url);
  return `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
}

function capLine(model: DashboardModel): string {
  if (!model.cap.enabled) {
    return `No cap configured — ${model.used} environment${model.used === 1 ? '' : 's'} recorded.`;
  }
  return `${model.used} of ${model.cap.limit} environments used.`;
}

function statusCell(row: DashboardRow): string {
  if (row.isProtected) return '<strong>protected</strong>';
  if (row.reclaimable) return '<strong>reclaimable</strong>';
  // A warm slot is the pool doing its job, never a freeable leftover (chg-002): claimable
  // once its build's commit is recorded, building until then.
  if (row.record.state === 'warm') {
    return row.record.deployedCommit === null ? 'warm — building' : 'warm — claimable';
  }
  return 'in use';
}

function listRow(row: DashboardRow): string {
  const { record } = row;
  const anchor = `env-${escapeHtml(record.identity)}`;
  return `<tr class="${row.reclaimable ? 'reclaimable' : row.isProtected ? 'protected' : 'in-use'}">
  <td><a href="#${anchor}">${escapeHtml(record.identity)}</a></td>
  <td>${row.pullRequest ?? '—'}</td>
  <td>${escapeHtml(record.state)}</td>
  <td>${statusCell(row)}</td>
  <td>${escapeHtml(record.updatedAt)}</td>
  <td>${record.deployedCommit === null ? PENDING : `<code>${escapeHtml(record.deployedCommit)}</code>`}</td>
  <td>${urlCell(record.url)}</td>
</tr>`;
}

function detailSection(row: DashboardRow): string {
  const { record } = row;
  const field = (name: string, value: string): string => `<dt>${name}</dt><dd>${value}</dd>`;
  return `<section id="env-${escapeHtml(record.identity)}">
<h2>${escapeHtml(record.identity)}</h2>
<dl>
${field('Repository', escapeHtml(record.repository))}
${field('Identity', escapeHtml(record.identity))}
${field('Pull request', row.pullRequest === null ? '—' : String(row.pullRequest))}
${field('State', escapeHtml(record.state))}
${field('Protected', row.isProtected ? 'yes' : 'no')}
${field('Deployed commit', record.deployedCommit === null ? PENDING : `<code>${escapeHtml(record.deployedCommit)}</code>`)}
${record.claimant === null ? '' : `${field('Claimant pull request', String(record.claimant))}\n`}${field('Created', escapeHtml(record.createdAt))}
${field('Updated', escapeHtml(record.updatedAt))}
${field('URL', urlCell(record.url))}${deployInputRows(record.deployInputs, field)}
</dl>
</section>`;
}

/**
 * The recorded deploy inputs, when the record carries any — one line per input, sorted
 * by name so the render is deterministic whatever key order the stored JSON held.
 *
 * These values are the field the hostile-content rule exists for: attacker-suppliable
 * by design, so name and value are both escaped, and a value is NEVER linkified however
 * much it looks like a URL (chg-001; plan D5). Shown as plain wrapped text, full length.
 * A record without them renders nothing here — not a pending placeholder, because no
 * later step fills them in: a record without them never declared any.
 */
function deployInputRows(
  inputs: Readonly<Record<string, string>> | null,
  field: (name: string, value: string) => string,
): string {
  if (inputs === null) return '';
  return Object.keys(inputs)
    .sort()
    .map((name) => `\n${field(`Input ${escapeHtml(name)}`, `<code>${escapeHtml(inputs[name] ?? '')}</code>`)}`)
    .join('');
}

const STYLE = `body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.8rem; border-bottom: 1px solid #ccc; }
tr.reclaimable td { background: #f3fbf3; }
tr.protected td { background: #fbf7ef; }
code { font-size: 0.9em; }`;

export function renderDashboardPage(model: DashboardModel): string {
  const body =
    model.rows.length === 0
      ? `<p>No environments. The registry records nothing for this repository.</p>`
      : `<table>
<thead><tr><th>Environment</th><th>PR</th><th>State</th><th>Status</th><th>Last deployed</th><th>Commit</th><th>URL</th></tr></thead>
<tbody>
${model.rows.map(listRow).join('\n')}
</tbody>
</table>
${model.rows.map(detailSection).join('\n')}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skyhook — ${escapeHtml(model.repository)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Environments — ${escapeHtml(model.repository)}</h1>
<p>${capLine(model)}</p>
${body}
</body>
</html>`;
}
