/**
 * `skyhook dashboard` — the local, read-only page showing what the registry records
 * (feat-005): every environment, how close the repository is to its cap, which slot
 * can be freed, and each environment's URL.
 *
 * A human command, in the destruct family of surfaces: config read from the working
 * tree, repository from the git remote, credentials from the developer's own `aws`
 * CLI. It serves on 127.0.0.1 only — nothing is hosted, which is how the prototype
 * answers "the dashboard is not publicly readable" (od-1; real authentication is
 * recorded promote debt). Every GET takes a fresh snapshot, so a browser refresh is
 * the update mechanism.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { parseConfig, CONFIG_PATH } from '../core/config.ts';
import { Registry } from '../core/registry.ts';
import { buildDashboardModel, renderDashboardPage } from '../core/dashboard.ts';
import { fetchRegistrySnapshot } from '../adapters/aws/snapshot.ts';
import { parseRepository } from './bootstrap.ts';
import type { CommandRunner } from './process.ts';

export interface DashboardOptions {
  readonly repositoryRoot: string;
  readonly runner: CommandRunner;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly repository?: string | undefined;
  /** 0 (the default) asks the OS for an ephemeral port. */
  readonly port?: number | undefined;
}

export type StartOutcome =
  | { readonly ok: true; readonly url: string; readonly close: () => Promise<void> }
  | { readonly ok: false; readonly problem: string };

/**
 * Starts the server and returns; `dashboard()` below is the run-until-interrupted
 * wrapper the CLI uses. Split so tests drive a real loopback socket and still get to
 * stop it (feat-005/AC-7's seam).
 */
export async function startDashboard(options: DashboardOptions): Promise<StartOutcome> {
  const configPath = join(options.repositoryRoot, CONFIG_PATH);
  if (!existsSync(configPath)) {
    return { ok: false, problem: `no ${CONFIG_PATH} here — run this from the consuming repo` };
  }
  const config = parseConfig(readFileSync(configPath, 'utf8'));
  if (!config.ok) return { ok: false, problem: `${CONFIG_PATH}: ${config.problems.join('; ')}` };
  const { bucket, region } = config.config.storage;
  const cap = config.config.environmentCap;

  const repository = options.repository ?? (await repositoryFromGit(options));
  if (repository === null) {
    return {
      ok: false,
      problem: 'could not work out the repository from the git remote — pass --repository owner/name',
    };
  }

  const server = createServer((request, response) => {
    void (async () => {
      const page = await renderCurrentPage(options, bucket, region, repository, cap);
      response.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page.html);
    })().catch((error: unknown) => {
      // Detail belongs on the terminal; the response stays generic (analyze S7).
      options.err(`skyhook dashboard: ${String(error)}`);
      response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      response.end(FAILURE_PAGE);
    });
    void request;
  });

  const url = await new Promise<string | null>((resolve) => {
    server.once('error', () => resolve(null));
    // Loopback only. There is deliberately no flag to widen this: binding any other
    // address would publish the page, which product-global forbids (od-1).
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      resolve(
        address !== null && typeof address === 'object'
          ? `http://127.0.0.1:${address.port}/`
          : null,
      );
    });
  });
  if (url === null) {
    return { ok: false, problem: 'could not listen on 127.0.0.1 — is the port already in use?' };
  }

  options.out(`Dashboard for ${repository}: ${url}`);
  options.out('Reads the registry on every load; refresh to update. Ctrl-C to stop.');
  return { ok: true, url, close: () => closeServer(server) };
}

/** The CLI entry: start, then hold until the developer interrupts. */
export async function dashboard(options: DashboardOptions): Promise<number> {
  const started = await startDashboard(options);
  if (!started.ok) {
    options.err(`skyhook dashboard: ${started.problem}`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      void started.close().then(resolve);
    });
  });
  return 0;
}

const FAILURE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>skyhook dashboard</title></head>
<body><h1>Could not read the registry</h1>
<p>The dashboard could not take a snapshot of the registry. The reason is printed in the
terminal where <code>skyhook dashboard</code> is running — an expired login is the usual one.</p>
</body></html>`;

async function renderCurrentPage(
  options: DashboardOptions,
  bucket: string,
  region: string,
  repository: string,
  cap: import('../core/types.ts').EnvironmentCap,
): Promise<{ status: number; html: string }> {
  const snapshot = await fetchRegistrySnapshot(options.runner, bucket, region, repository);
  if (!snapshot.ok) {
    options.err(`skyhook dashboard: could not read the registry: ${snapshot.problem}`);
    return { status: 500, html: FAILURE_PAGE };
  }

  const listed = await new Registry(snapshot.store).list(repository);
  if (!listed.ok) {
    options.err(`skyhook dashboard: could not read the registry: ${listed.reason}`);
    return { status: 500, html: FAILURE_PAGE };
  }

  const model = buildDashboardModel(repository, listed.records, snapshot.protectedIdentities, cap);
  return { status: 200, html: renderDashboardPage(model) };
}

async function repositoryFromGit(options: DashboardOptions): Promise<string | null> {
  const result = await options.runner.run('git', ['remote', 'get-url', 'origin'], {
    cwd: options.repositoryRoot,
  });
  if (result.code !== 0) return null;
  return parseRepository(result.stdout.trim());
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive connections would otherwise hold close() open indefinitely.
    server.closeAllConnections();
  });
}
