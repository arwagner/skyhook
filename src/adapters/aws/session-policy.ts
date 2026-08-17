/**
 * The policy that narrows a run to one environment.
 *
 * **This is a guardrail against accident, not a boundary the cloud enforces.** Between two
 * preview environments the line is skyhook's own code, deliberately: this document keeps an
 * honest run out of a sibling's environment, and does nothing whatever to a run that declines
 * to ask for it. The workflow that calls skyhook is a file a pull request may edit (plan D2),
 * and a workflow that skips skyhook skips this narrowing with it. That is a decision with a
 * stated cost, not a gap — see the constitution's "Preview environments are not isolated from
 * each other, by decision", which also says what it costs: state holds resource attributes in
 * the clear, so a sibling preview can read any credential the infrastructure generated for
 * itself.
 *
 * What IS the cloud's to refuse — every long-running environment, every other repository,
 * every protection mark — is the role's own floor, expressed in `roles.tf` and denied on every
 * request whether or not skyhook thinks to ask. That is AC-7. This file is AC-19, which is
 * about what skyhook ASKS FOR, and the two are separate criteria on purpose (`chg-001`).
 *
 * A trust condition pinning these credentials to a workflow stored on the default branch was
 * designed and then withdrawn with the requirement it served. It is named here only because
 * its absence is the whole reason the paragraphs above read as they do.
 *
 * A session policy can only ever *narrow* what the role already permits. It cannot grant
 * anything, which is why passing one is safe even though skyhook computes it: the worst a
 * bug here can do is refuse work skyhook is entitled to do.
 */

import { REGISTRY_PREFIX, protectionKeyFor, registryKeyFor, stateDirFor } from '../../core/registry.ts';

export interface SessionPolicyRequest {
  readonly bucket: string;
  readonly repository: string;
  readonly identity: string;
  /**
   * Teardown's variant (feat-003 plan D3a): the session also asks to READ this one
   * environment's protection marker, and — to stay inside the 2048-character ceiling —
   * drops the belt-and-braces `NoOthers` deny. Dropping it narrows nothing: a session
   * policy is an intersection, so anything it does not allow is already refused, and the
   * role's own explicit denies (other repositories, long-running environments, every
   * protection-mark write) stand regardless. The deploy path never sets this, and its
   * policy stays byte-identical to what feat-002 shipped and specified (its AC-19); the
   * spec sentences this variant touches move in feat-003's task 5.2, together with the
   * constitution's third exception.
   */
  readonly readProtection?: boolean;
}

/**
 * The inline policy an `AssumeRoleWithWebIdentity` call carries.
 *
 * **Listing is deliberately wider than acting.** Terraform enumerates the environments it
 * knows about by listing the state prefix, and the environment cap is counted by listing
 * the registry prefix — neither can be done one key at a time. So a run may see that other
 * environments exist and may do nothing whatever to them: every read, write and delete is
 * confined to its own two keys, and an explicit deny covers everything else.
 */
export function sessionPolicyFor(request: SessionPolicyRequest): string {
  const bucketArn = `arn:aws:s3:::${request.bucket}`;
  const ownObjects = [
    `${bucketArn}/${registryKeyFor(request.repository, request.identity)}`,
    `${bucketArn}/${stateDirFor(request.repository, request.identity)}*`,
  ];

  /**
   * This environment's own protection marker, read-only (feat-003 plan D3a).
   *
   * Teardown must honor a marker before destroying, and a refusal to read one is
   * indistinguishable from its absence — so the session asks for the read, narrowed to
   * the ONE claimed environment's marker even though the role-level grant is repo-wide.
   * Whether the read is actually granted is the role's decision: until the constitution's
   * third named exception lands in `roles.tf`, the role still denies it, the intersection
   * refuses, and teardown fails closed. Writes and deletes are never asked for.
   */
  const ownProtection = `${bucketArn}/${protectionKeyFor(request.repository, request.identity)}`;

  /**
   * The one key outside this environment that the run may read (chg-008 against feat-001).
   *
   * The infrastructure tool consults its default workspace's state before it can be told which
   * environment it is working on, and that state lives at the root of the bucket — outside every
   * prefix this session is narrowed to. Denying it does not protect anything: skyhook never
   * writes there, so there is nothing to read. It only stops the first deploy of a new
   * environment, which is exactly what it did.
   *
   * Read only, and it stays out of `ownObjects` so no write path can ever pick it up.
   *
   * A second explicit deny on writing it would be belt-and-braces, and it is deliberately NOT
   * here: it cost 150 characters and this document has a hard 2048-character ceiling that fails
   * at assume time, in CI, when it is exceeded. The write is already refused twice over — the
   * allow below names `GetObject` alone, and the role policy this session narrows grants no more
   * than a read on this key either. An effective permission is the intersection of the two.
   */
  const defaultWorkspaceState = `${bucketArn}/terraform.tfstate`;

  const readProtection = request.readProtection === true;
  const readOnlyKeys = readProtection ? [defaultWorkspaceState, ownProtection] : [defaultWorkspaceState];

  const listPrefixes = [
    `registry/${request.repository}/*`,
    `state/${request.repository}/*`,
    // Not to list anything. S3 answers a HeadObject on a MISSING object with 403
    // rather than 404 unless the caller could also have listed it, so without this the
    // read permitted below is never reached — the object has never existed (chg-008).
    'terraform.tfstate',
    // Same 403-versus-404 mechanics for the protection marker: the common case is that no
    // marker exists, and that must answer "not there", not "refused" — a refusal is
    // exactly what teardown fails closed on (feat-003 plan D3a).
    ...(readProtection ? [protectionKeyFor(request.repository, request.identity)] : []),
  ];

  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Own',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: ownObjects,
      },
      {
        Sid: 'List',
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': listPrefixes } },
      },
      // A `NoMarks` deny on `protected/*` used to sit here, and it was belt and braces by its own
      // comment. It was SPENT, deliberately, to buy the default-workspace read below (chg-008):
      // this document has a hard 2048-character ceiling, the worst plausible repository takes it
      // to 2153 with both, and 1999 with only one. Exceeding it fails at assume time in CI, which
      // is worse than either.
      //
      // A protection-mark WRITE is still refused twice on every variant: the deploy variant's
      // `NoOthers` below denies everything this session does not name, and the pull-request ROLE
      // carries its own explicit deny on protection-mark writes, which no session policy can
      // widen (feat-001/AC-15).
      // The read-only grant: the default-workspace state (chg-008), joined — on teardown's
      // variant only — by this environment's own protection marker (feat-003 plan D3a). The
      // deploy variant keeps the exact shape feat-002 shipped and its tests pin.
      readProtection
        ? { Sid: 'ReadOnly', Effect: 'Allow', Action: ['s3:GetObject'], Resource: readOnlyKeys }
        : {
            Sid: 'DefaultWorkspace',
            Effect: 'Allow',
            Action: ['s3:GetObject'],
            Resource: defaultWorkspaceState,
          },
      // Teardown's variant spends the `NoOthers` deny the same way chg-008 spent `NoMarks`:
      // with the marker's two extra ARNs aboard, the worst plausible repository blows the
      // 2048-character ceiling with the deny and fits without it. Dropping it widens nothing —
      // a session policy is an INTERSECTION, so an action or resource the allows above do not
      // name is refused with or without this statement, and the role's own explicit denies
      // stand regardless. The deploy variant keeps it: belt and braces are worth having where
      // they are affordable.
      ...(readProtection
        ? []
        : [
            {
              Sid: 'NoOthers',
              Effect: 'Deny',
              Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
              NotResource: [...ownObjects, ...readOnlyKeys],
            },
          ]),
    ],
  });
}

export interface ScoutPolicyRequest {
  readonly bucket: string;
  readonly repository: string;
}

/**
 * The pool-scout session (feat-007 plan D4, chg-009): the first of a pooled deploy's two
 * sessions, holding exactly what the constitution's fourth named exception grants — read
 * of this repository's warm-slot records, the conditional claim write on them, and the
 * listing that finds them. Nothing else: no state prefixes, no protection marks, no
 * non-slot record bodies, and no delete anywhere, so a destroy stays impossible from
 * this session however skyhook's code misbehaves (feat-007/AC-11). Once a claim
 * resolves, the run opens the ordinary narrowed session (`sessionPolicyFor`) for the one
 * resolved environment, exactly as an unpooled run does.
 *
 * The claim write and a record creation are the same physical permission — the cloud
 * cannot tell a conditional update from a first put on the same key — so minting a slot
 * record is skyhook's guardrail, priced in the constitution's fourth exception, not a
 * refusal this document can express.
 */
export function scoutPolicyFor(request: ScoutPolicyRequest): string {
  const bucketArn = `arn:aws:s3:::${request.bucket}`;
  const slotRecords = `${bucketArn}/${REGISTRY_PREFIX}${request.repository}/slot-*`;
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Slots',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: [slotRecords],
      },
      {
        Sid: 'List',
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': [`${REGISTRY_PREFIX}${request.repository}/*`] } },
      },
      // Belt and braces, affordable here: this document is nowhere near the character
      // ceiling, so the deny the deploy variant carries is kept.
      {
        Sid: 'NoOthers',
        Effect: 'Deny',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        NotResource: [slotRecords],
      },
    ],
  });
}

/**
 * The hard limit on an inline session policy, in characters.
 *
 * Exceeding it fails at assume time — in CI, at the point credentials are needed — rather
 * than anywhere a test would see it, so the builder checks its own output.
 */
export const MAX_INLINE_POLICY_LENGTH = 2048;
