# Changelog

Notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] — 2026-11-07

Quality stages, and a fix that lets a flagged endpoint recover. No contract
change: the registry and the lens stay as deployed.

### Added

- Quality stages: Listed, Verified, Reliable, Preferred. Each stage adds
  pass-or-fail gates to the one below, and each gate carries its measured value,
  so an operator can see what holds an endpoint where it is. The rule lives in
  `web/stage.js`, a dependency-free file the directory, wallets and scripts can
  share. Stages are computed in the browser from on-chain records and verified
  feeds, and are never written to the chain.
- The directory shows a stage meter per endpoint, the first gate blocking the
  next stage, a stage filter, a "highest stage first" sort (now the default) and
  a legend generated from the rule itself. The footer prints the stage policy
  version.
- `stagePolicy` in `web/config.js` for deployments that tune thresholds. A
  changed policy reports a different version.
- Checker snapshots carry `stats_7d` and `first_seen`, the earliest probe still
  held for the endpoint's epoch. Both are additive; the schema stays `v3`. A
  directory treats feeds without them as unmeasured, which caps an endpoint at
  Verified until its checkers upgrade.
- `test/test_stage.js`, every gate at its boundary, on plain Node.

### Changed

- The directory's RPC fallback follows the wallet rule: registered EVM endpoints
  that are Reliable or better and at target today, Preferred first.
- Checker 3.1.0 reads each endpoint's 30-day window once per cycle and slices
  the shorter windows from it.

### Fixed

- A flagged endpoint could never recover at the default settings. It is probed
  in one minute out of `--unreliable-divisor` (10), about 250 probes a day,
  while a daily attestation needed 1,000 counted probes. No healthy report was
  ever filed, so the only way out was a paid URL change. The sample floor is now
  divided by the same divisor for flagged endpoints.
- `test/e2e.js` failed on Node 22 and later, which jsdom 30 requires: the
  harness passed jsdom's `AbortSignal` to Node's fetch. It now forwards it to a
  native one.
- The e2e check for the lifetime flagged-day count matched any text containing
  "flagged day". It now looks for the count itself.

## [2.0.0] — 2026-08-02

A rewrite following a full design review. Version 1 does not compile and its
checker cannot submit an attestation; see [docs/REVIEW.md](docs/REVIEW.md) for
every finding, its fix, and the test that covers it.

**Not compatible with 1.x.** Different constructor, different ABI, different
storage. Redeploy rather than migrate.

### Added

- `GenesisL1RegistryLens`, a stateless read aggregator. Deploy a new one to change
  the shape of the data clients read without touching state or funds.
- Signed telemetry. Snapshots ship with a detached signature over their exact
  bytes; the directory discards feeds it cannot attribute to an authorized checker.
- Proof of endpoint control, via DNS TXT or `/.well-known/`, quorum-attested and
  revoked by any URL change.
- Recovery attestations. A quorum of healthy measurements clears a flag on-chain,
  free — previously the only exit was a paid write.
- `contestEndpoint`, an operator's free public right of reply to a flag.
- Two-day timelock on checker authorization, configuration, and fee-recipient
  changes. Revocation stays immediate.
- Lifetime `adverseDayCount` that no path resets.
- 24-hour hourly traces in the telemetry schema, rendered per endpoint.
- Two-step handover for both the admin role and instance ownership.
- 177 tests across three suites, plus CI that fails on ABI drift, EIP-170
  overflow, or a key committed under `web/`.

### Changed

- Fees accrue in the contract and are pulled by a separate permissionless call,
  instead of being pushed on every write. A fee recipient that cannot receive
  value can no longer block registrations.
- `submitReports` and `submitVerifications` merged into `attest(Attestation[])`.
- The measurement epoch advances only when the URL or API type actually changed.
  The fee is charged either way.
- WebSocket and gRPC probes now complete a real handshake instead of a TCP connect.
- Rate-limited probes are excluded from the uptime denominator.
- Flagged endpoints are still probed, at a reduced rate, so they can accumulate
  the evidence that clears them.
- The reliability target, fee and quorum are read from the contract, not config.
- RPC failover, then self-bootstrapping from healthy registered endpoints.
- Per-address instance cap raised from 2 to 4; documented as a speed bump rather
  than a Sybil defence.
- The interface was rebuilt: dark mode, an hourly availability trace per endpoint,
  visible per-checker consensus, and all owner actions reachable.
- Telemetry schema `v2` → `v3`.

### Fixed

- The contract did not compile under stock Remix settings.
- The checker's ABI did not match the contract, so no attestation could ever land.
- The documented constructor did not exist.
- SSRF: hostname validation could be defeated by DNS rebinding, and redirects were
  followed to arbitrary targets.
- Unbounded response reads could exhaust checker memory.
- ethers was loaded from a CDN with no integrity check, on a page that signs
  transactions.
- Paying for a no-op endpoint edit erased a reliability record from both the chain
  and local history.
- Attestations were attributed to the epoch at inclusion time, not measurement.
- One unusable entry reverted an entire attestation batch.
- Attestations were marked submitted on send rather than on a successful receipt.
- A "24 hour" claim could be filed on twenty minutes of data.
- The private key could be passed as a command-line argument.
- The default bind was `0.0.0.0`.
- `addEndpoints`, `updateInstance` and `reactivateEndpoint` were unreachable from
  the interface.
- On-chain attestations were written and never displayed.

### Security

Full model in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). The properties now
enforced by constants rather than by policy: quorum floor of 2, reliability target
floor of 50%, write fee ceiling of 1,000 L1 coin.

## [1.0.0] — 2026-08-02

Initial "Static Edition". Superseded; do not deploy.
