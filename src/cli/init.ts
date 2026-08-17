/**
 * `skyhook init` — write everything a consuming repo needs, and apply nothing.
 *
 * No cloud resource is created here, and no credential is required to run it. What init produces
 * is a definition for the maintainer to read and apply themselves. That is not timidity: the
 * bootstrap creates the trust anchor and the roles, which is exactly the material a reviewer
 * should see before it exists.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyInstall, changed, type DesiredFile, type InstallReport } from '../core/install.ts';
import { CONFIG_PATH, DEFAULT_ENVIRONMENT_CAP, DEFAULT_ROLE_PREFIX } from '../core/config.ts';

export interface InitOptions {
  /** Where the consuming repo lives. Only used to place files; never affects their content. */
  readonly repositoryRoot: string;
  /** The consuming repo, as `owner/name`. */
  readonly repository: string;
  /** The bucket the bootstrap will create. Globally unique across AWS, so the operator picks it. */
  readonly bucket: string;
  readonly region: string;
  readonly defaultBranch?: string | undefined;
}

export interface InitResult {
  readonly report: InstallReport;
  /** What to print. Ordinary output, not diagnostics. */
  readonly messages: readonly string[];
}

const WORKFLOW_PATH = '.skyhook/workflow.yml';
/** Where the operator copies it. Fixed by feat-002 plan D2 so every message names one path. */
const DEPLOY_WORKFLOW_PATH = '.github/workflows/skyhook.yml';
const DEPLOY_ROLE_PATH = '.skyhook/deploy-role.example.tf';
const DEPLOY_ROLE_SOURCE = new URL('../../terraform/deploy-role.example.tf', import.meta.url)
  .pathname;
const GITIGNORE_PATH = '.skyhook/.gitignore';
const BOOTSTRAP_DIR = '.skyhook/bootstrap';

/** Skyhook's own copy of the bootstrap definition, which init copies into the consuming repo. */
const BOOTSTRAP_SOURCE = new URL('../../terraform/bootstrap/', import.meta.url).pathname;

export function init(options: InitOptions): InitResult {
  const files = desiredFiles(options);
  const report = applyInstall(options.repositoryRoot, files);
  return { report, messages: describe(options, report) };
}

/**
 * The desired content of every file skyhook manages. A pure function of the options — the
 * repository root decides where files go, never what is in them — which is what makes a re-run
 * byte-identical (AC-2).
 */
export function desiredFiles(options: InitOptions): DesiredFile[] {
  return [
    // The one seeded file. Everything below it is skyhook's own content and stays restored, so an
    // installation still converges on a re-run — only the operator's answers are left alone.
    { path: CONFIG_PATH, content: configDocument(options), rule: 'seed' },
    { path: WORKFLOW_PATH, content: workflowDocument(options) },
    { path: DEPLOY_ROLE_PATH, content: readFileSync(DEPLOY_ROLE_SOURCE, 'utf8') },
    { path: GITIGNORE_PATH, content: GITIGNORE },
    ...bootstrapFiles(),
  ];
}

function bootstrapFiles(): DesiredFile[] {
  return readdirSync(BOOTSTRAP_SOURCE)
    .filter((name) => name.endsWith('.tf'))
    .sort()
    .map((name) => ({
      path: `${BOOTSTRAP_DIR}/${name}`,
      content: readFileSync(join(BOOTSTRAP_SOURCE, name), 'utf8'),
    }));
}

/**
 * Which of skyhook's files belong in version control.
 *
 * The lock file is deliberately NOT ignored: it pins provider versions, and a change to it is a
 * change a reviewer should see. The state is ignored because after the first `skyhook bootstrap`
 * it does not live here at all — it lives in the bucket, encrypted and versioned. Ignoring it
 * before it had a home would only have made losing it silent instead of accidental.
 */
const GITIGNORE = `# Terraform's working directory and provider cache. Recreated by \`skyhook bootstrap\`.
.terraform/

# Bootstrap state. After the first \`skyhook bootstrap\` this lives in your skyhook bucket, not
# here — encrypted, versioned, and readable by neither role skyhook installs. A copy left here is
# a leftover rather than a source of truth, and it can contain values you would not want in git.
*.tfstate
*.tfstate.*

# The lock file IS committed: it pins provider versions, and changing it should be reviewable.
!.terraform.lock.hcl
`;

function configDocument(options: InitOptions): string {
  return `# Skyhook settings for ${options.repository}.
#
# Read from this repository's DEFAULT BRANCH at run time, never from a pull request's own
# branch. That is deliberate: a pull request checks out its own code, so reading settings from
# the working tree would let a pull request raise its own environment cap or point skyhook at a
# bucket of its choosing. Change these on the default branch and they take effect everywhere.
#
# THIS FILE IS YOURS. Skyhook writes it once, when there is none, and never touches it again —
# re-running \`skyhook init\` leaves it exactly as you left it, and reports it as left alone. Every
# other file in .skyhook/ is skyhook's own and IS restored on a re-run, so an installation still
# repairs itself; this one is excepted because the answers below are yours and some of them cannot
# be known until after the bootstrap has applied.
#
# The consequence worth knowing: if this file is broken rather than merely incomplete, skyhook will
# not repair it. Delete it and run \`skyhook init\` again to get a fresh one.

storage:
  # Created by the bootstrap definition in .skyhook/bootstrap/. Skyhook never creates this
  # bucket: if it is missing, skyhook stops and names it rather than creating a resource
  # Terraform believes it owns.
  bucket: ${options.bucket}
  region: ${options.region}
  # FILL THIS IN to deploy. It is the \`account_id\` output of the bootstrap, which is why it is
  # blank here — \`init\` runs before the bootstrap has applied, so the account is not yet knowable.
  # Skyhook builds the role identifiers it assumes from it, so no role identifier is ever typed
  # into this file or into your workflow, where the two could drift apart.
  # QUOTE IT: unquoted, an account id is read as a number and skyhook refuses it rather than
  # deriving a role identifier from a mangled account.
  #account: "000000000000"

# FILL THIS IN to deploy. Without it, this installation does not deploy — which is a valid state,
# and how every installation starts. Skyhook cannot infer where your infrastructure lives, and does
# not guess: guessing would mean applying the wrong directory with credentials that create real
# resources.
#deploy:
#  # Where your own Terraform lives, relative to the repository root. Skyhook applies this
#  # directory once per environment, as a Terraform workspace named after the environment. Your
#  # definition reads \`terraform.workspace\` to name its own resources; skyhook passes no variables.
#  directory: infra
#  # Skyhook looks for a role named <prefix>-deploy. Declare it yourself — start from
#  # .skyhook/deploy-role.example.tf. Optional; defaults to "${DEFAULT_ROLE_PREFIX}".
#  role_prefix: ${DEFAULT_ROLE_PREFIX}

environment_cap:
  # How many environments this repository may hold at once. Set enabled to false to lift the
  # cap entirely. An unrecognized setting here is an error, not something skyhook ignores — a
  # silently-defaulted cap is the difference between 5 environments and 50.
  enabled: ${DEFAULT_ENVIRONMENT_CAP.enabled}
  limit: ${DEFAULT_ENVIRONMENT_CAP.limit}
`;
}

function workflowDocument(options: InitOptions): string {
  const defaultBranch = options.defaultBranch ?? 'main';
  return `# Skyhook's calling workflow for ${options.repository}.
#
# COPY THIS to ${DEPLOY_WORKFLOW_PATH} to switch it on. Init deliberately leaves it here rather
# than writing straight into .github/workflows/, because skyhook restores every file it manages
# to its desired content — and silently reverting your CI configuration is not a surprise anyone
# should get.
#
# IT MUST REACH YOUR DEFAULT BRANCH BEFORE IT DOES ANYTHING. GitHub reads \`on: pull_request\`
# from the default branch, so a pull request opened while this file exists only on a branch runs
# nothing at all — and nothing explains why.

name: skyhook

on:
  pull_request:
    # \`closed\` is the teardown fast path: the environment dies with its pull request. It is a
    # fast path ONLY — the scheduled sweep below repairs any close this misses, so removing one
    # of these lines slows cleanup down without ever making it wrong.
    types: [opened, synchronize, reopened, closed]
  schedule:
    # The sweep: destroys every environment whose pull request is closed and which nothing
    # protects. This line is what makes cleanup a guarantee rather than a hope. GitHub's
    # scheduler treats this as a floor, not a promise — quiet repositories run late.
    - cron: '*/15 * * * *'
  # UNCOMMENT the two push lines to keep a LONG-RUNNING environment — staging, a demo — tracking
  # your default branch: every push to it then deploys the same named environment, updated in
  # place. Also name the environment in the skyhook step's \`environment\` line below. Choose any
  # name NOT beginning \`pr-\` (that namespace belongs to pull-request environments). Nothing
  # automatic ever destroys it — not the close event, not the sweep. It dies only by the manual
  # teardown dispatched below.
  # push:
  #   branches: [${defaultBranch}]
  workflow_dispatch:
    # The manual verbs, for a human to run from the Actions tab — DISPATCH AGAINST THE DEFAULT
    # BRANCH; no other ref qualifies for the credentials these need.
    #   teardown   destroys the named environment, removes its record, frees the name.
    #   protect    latches it against destruction: even the manual teardown then refuses until a
    #              human unprotects first. Protection guards DESTRUCTION ONLY — pushes still
    #              update a protected environment in place.
    #   unprotect  clears the latch.
    inputs:
      command:
        description: What to do with the environment
        type: choice
        options: [teardown, protect, unprotect]
        required: true
      environment:
        description: The environment to act on
        required: true

# No long-lived cloud credential exists anywhere in this setup. The job requests a short-lived
# OIDC token; skyhook exchanges it for short-lived credentials itself, and narrows its own to the
# single environment this pull request claimed before your Terraform runs.
# \`pull-requests: read\` exists for the sweep: it decides what is eligible by asking GitHub
# whether each recorded pull request is actually closed, never by trusting that an event fired.
permissions:
  contents: read
  id-token: write
  pull-requests: read

jobs:
  skyhook:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: skyhook
        # Pin this to a tag once skyhook publishes one. \`@main\` means you run whatever is on
        # skyhook's default branch at the time your pull request opens.
        uses: arwagner/skyhook@main
        with:
          # A manually dispatched run carries its verb and its target from the inputs above.
          # Every other trigger ignores them: what triggered the run decides the verb.
          command: \${{ inputs.command }}
          # The environment a run acts on. For a dispatched command this is its input; the
          # fallback after || is where a push-triggered deploy reads its name — switching on the
          # push trigger above means replacing '' with your chosen name, e.g. 'staging'.
          environment: \${{ inputs.environment || '' }}

      # The environment's address, for you to do as you like with. Skyhook asks for no permission
      # to write to a pull request and owns no comment format.
      - if: steps.skyhook.outputs.url != ''
        # Quoted, and it has to stay quoted. A YAML plain scalar may not contain ": " — the
        # parser reads it as a key — so an unquoted echo with a colon in its message makes the
        # whole file unparseable. GitHub does not report that as an error you can find: it
        # silently attributes a failed run to the push that introduced the file, names the
        # workflow after its own path, and never fires the trigger at all.
        run: 'echo "Environment: \${{ steps.skyhook.outputs.url }}"'

# You may edit this file on a pull request, and it is worth knowing exactly what that changes.
#
# It gains you NO wider credentials. What a run may assume is decided by what TRIGGERED it, not
# by what this file says: a job on a pull request presents \`repo:${options.repository}:pull_request\`
# whatever workflow it came from, so the privileged default-branch role stays out of reach.
#
# What it can do is decline to run skyhook, and so decline the narrowing skyhook asks for — which
# is what keeps one preview environment out of another's. That boundary is skyhook's code, not
# the cloud's, and that is a deliberate choice with a stated cost. See the constitution's
# "Preview environments are not isolated from each other", and the notes printed by the bootstrap.
#
# NOTE: this workflow inherits no secrets, and must not be changed to. A job running a pull
# request's own Terraform must not be handed every secret in the repository.
`;
}

function describe(options: InitOptions, report: InstallReport): string[] {
  const messages: string[] = [];
  const edits = changed(report);

  if (edits.length === 0) {
    messages.push('Skyhook is already up to date. Nothing changed.');
  } else {
    messages.push(`Skyhook wrote ${edits.length} file${edits.length === 1 ? '' : 's'}:`);
    for (const edit of edits) {
      messages.push(`  ${edit.kind === 'created' ? 'created ' : 'restored'}  ${edit.path}`);
    }
  }

  // Said out loud rather than shown by omission. An operator who expects `init` to repair their
  // settings has to learn here that it will not — silence would read as "nothing to report", and
  // they would find out at deploy time instead (feat-002/AC-20).
  const kept = report.changes.filter((change) => change.kind === 'kept');
  for (const file of kept) {
    messages.push(`  left alone  ${file.path}  (yours — skyhook wrote it once and stops there)`);
  }

  messages.push(
    '',
    'Nothing has been created in your cloud account. Four steps, and the ORDER matters —',
    'a pull request opened before step 4 lands runs nothing at all, and says nothing about why.',
    '',
    // Read the roles first, then let skyhook apply them. `chg-009` is why this is not a bare
    // `terraform apply` any more: the trust policies pin the OIDC subject a run presents, whose
    // form is the organization's rather than skyhook's, and `subject_prefix` is a required
    // variable with no default because a default would silently restore the assumption it exists
    // to remove. `skyhook bootstrap` asks GitHub for it. An operator cannot, so a command line
    // they could copy would stop on a prompt for a string they have never heard of.
    `  1. Read ${BOOTSTRAP_DIR}/roles.tf — it is the whole security model — then apply it:`,
    // The trust policy names this branch, and only workflows on it may assume the privileged
    // role. Omitted when it is the default the bootstrap already assumes, so the common case
    // stays a line an operator reads rather than skims.
    options.defaultBranch !== undefined && options.defaultBranch !== 'main'
      ? `       skyhook bootstrap --default-branch ${options.defaultBranch}`
      : '       skyhook bootstrap',
    '     It reads your settings, works out what already exists, shows you the plan, and waits.',
    `  2. Uncomment storage.account in ${CONFIG_PATH} and put its account_id output there,`,
    '     then uncomment the deploy block below it and say where your Terraform lives.',
    `  3. Declare your own deploy role — start from ${DEPLOY_ROLE_PATH}, fill in the`,
    '     permissions your infrastructure needs, and apply it. Skyhook never creates it.',
    `  4. Copy ${WORKFLOW_PATH} to ${DEPLOY_WORKFLOW_PATH} and MERGE IT TO YOUR`,
    '     DEFAULT BRANCH. GitHub reads pull_request triggers from there, not from a branch.',
    '',
    'The same workflow also carries the long-running pieces, off by default: uncomment its push',
    'block to keep a named environment (staging, a demo) tracking your default branch, and use',
    'its manual dispatch — Actions → skyhook → Run workflow, against the default branch — to',
    'tear one down, protect it, or unprotect it. Protection guards destruction only: even the',
    'manual teardown refuses a protected environment until a human unprotects it first.',
    '',
    // The instruction in step 2 used to be one `init` would later undo. Saying so here is what
    // stops an operator treating the settings file as skyhook's and their edits as temporary.
    `Step 2 sticks. ${CONFIG_PATH} is yours: re-running this command leaves it alone, so your`,
    'answers survive every upgrade. If it is ever broken rather than merely incomplete, delete it',
    'and run this command again — skyhook will not repair a file it does not own.',
    '',
    // feat-001/AC-18, feat-002 chg-001 — the operator meets the boundary here, not buried in a
    // specification, and meets what it costs rather than only where it sits.
    'WHERE THE BOUNDARY IS: the role a pull-request run assumes reaches every pr-* environment',
    'in this repository, not only its own. It cannot reach a long-running environment, another',
    'repository, or any protection mark — the cloud refuses those. Between two preview',
    "environments there is no such line: skyhook narrows its own credentials to the one",
    'environment it claimed, and a run that declines to ask never gets the narrowing.',
    '',
    'What that costs you: Terraform state holds resource attributes in the clear, including any',
    'credential your infrastructure generates for itself. One preview environment can read',
    "another's state. If your previews mint real secrets, treat them as readable by any pull",
    'request on this repository. This is a decision, not a gap — the reasoning is in',
    `${BOOTSTRAP_DIR}/roles.tf and in the bootstrap's own output.`,
  );

  return messages;
}
