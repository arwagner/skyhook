# Delta — chg-009

> **A note on wording.** This feature already uses *identity* for an environment's name (`pr-482`,
> `staging`), which is the product's glossary term. The thing this change is about — what a CI run
> presents to the cloud when it asks to assume a role — is the **OIDC subject**, the vocabulary the
> spec already uses for the trust anchor. Keeping them apart matters: a criterion that said "the
> identity a run presents" would read, in this spec, as the environment it claimed.

## ADDED

**The form of the OIDC subject a run presents is discovered, not assumed.** A trust policy must name
the subject a CI run presents, and the shape of that subject is the organization's choice rather than
skyhook's: some organizations qualify it with immutable numeric ids, and a policy written against the
plain repository name refuses every run in one of those. Skyhook asks the CI host which form applies
before it writes a policy naming it, and states which form it used, because the failure mode of a
wrong answer is a refusal that explains nothing.

This means a boundary's shape is read from a setting outside the repository's own files, so what
makes it safe is worth stating rather than leaving to be reconstructed: **the answer is pinned at
install time and every way of getting it wrong fails closed.** A wrong form matches no subject at
all, so it costs an installation that does not work rather than one that trusts too much, and a later
change to the setting stops runs instead of silently widening them. The setting is writable only by
someone who already holds write access to the default branch — the same reasoning the constitution
uses to accept that preview environments are not isolated from each other.

- [ ] AC-32: The bootstrap determines for itself which form of OIDC subject a run in this repository
      will present, rather than assuming one or asking the operator to know. The trust policies it
      writes name the form the CI host reports. Where the host will not disclose it — the setting is
      readable only by a repository administrator — skyhook uses the conventional form, which is
      correct wherever that form applies and is announced rather than assumed (AC-33) wherever it
      might not be. So an operator who has never heard of the setting installs skyhook correctly
      without knowing it exists, and an operator who cannot read it is told what was assumed on
      their behalf.
- [ ] AC-33: The operator is told which form of subject was used, and whether the CI host stated it
      or skyhook fell back to the conventional one, before anything is applied. The two ways the
      question can go unanswered are treated differently and both are visible: a **refusal** to
      disclose the setting is a fallback, announced; an **unreachable or unintelligible** answer
      stops the bootstrap with that named as the cause, rather than writing a policy that would
      refuse every run for a reason nothing reports.
- [ ] AC-34: Whatever the bootstrap learns about the subject's form is fixed into the installation at
      the moment it is applied. A later change to the repository's OIDC settings can stop runs from
      being able to assume a role; it can never widen what the roles trust. Every way the question
      can be answered wrongly — a refusal, a stale answer, a mistyped one — yields credentials that
      reach less than intended, never more.

## MODIFIED

- **The trust anchor costs one human step, permanently** (*Known sharp edges*)
  - Was: keyless access to a cloud account cannot bootstrap itself, so the identity provider and
    roles require credentials that do not yet exist — a property of the trust model, not a gap to
    close later.
  - Now: unchanged in substance, and it now costs a second reach as well as a second credential. The
    bootstrap reads the CI host as well as the cloud account, to learn which form of OIDC subject the
    repository's runs present. Where that read is refused — the setting needs repository admin —
    skyhook falls back to the conventional form and says so, which is correct wherever the
    conventional form applies and loudly wrong where it does not. An operator applying the definition
    by hand must supply that form themselves, and unlike every other variable it has no default,
    which is why the installation instructions send them to the command that works it out.

## REMOVED

None.
