# Security Policy

This policy covers the `@ninsei-labs/sdk` package and the code in this repository. The SDK handles key material,
cross-curve DLEQ proofs, recovery derivation and transaction signing requests, so we treat reports about those
paths as security reports even when the immediate impact is not yet clear.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.56.x` (latest release) | Yes |
| `< 0.56` | No |

Before 1.0, security fixes are made on the current line and published in the latest release. We do not backport to
older lines unless a supported integrator cannot move to the current release. The package requires Node.js 24.22.1
or newer.

## Report a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Use GitHub's private vulnerability reporting on this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue in the private advisory.

If private reporting is unavailable, open a minimal public issue asking the maintainers to enable a private
channel. Do not include exploit details, secrets, recovery words or reproduction steps in that issue.

A useful report includes:

- the affected version, commit and package subpath;
- the environment (Node version, browser, wallet, network, testnet or mainnet);
- the security impact and the conditions required to trigger it;
- a minimal reproduction or proof of concept, with all secrets redacted;
- relevant logs with mnemonic words, private keys and recovery envelopes removed;
- whether the issue is already public or known to another party.

Never send a mnemonic, private key, recovery-file plaintext or a real user's transaction data. If a proof of concept
needs a key, generate a disposable one on a local test network.

## What to expect

We aim to:

- acknowledge a private report within 3 business days;
- complete initial triage within 7 business days;
- provide a status update at least every 14 days while the report is open;
- prepare and release a fix within 90 days for confirmed issues, sooner when the issue is being exploited.

These are targets, not a warranty. A complex protocol change can need longer; we will say so and agree a disclosure
date with the reporter. We prefer coordinated disclosure and will credit the reporter in the advisory unless they
ask to remain anonymous.

## Scope

In scope:

- the published `@ninsei-labs/sdk` package and its `src`, `engine` and `assets` code;
- DLEQ proof generation and verification, knowledge proofs and transcript handling;
- recovery-key derivation, binding and recovery-file handling;
- EIP-712 terms, relay envelopes, HPKE handling and quote checks;
- sender, account and chain guards;
- adapters and the public package surface;
- build, packing, release workflow and supply-chain configuration in this repository.

Out of scope for this repository:

- the settlement contracts and their deployment;
- the RFQ node, relay service, frontend and local stand (report them in their own repositories);
- vulnerabilities in third-party wallets, browsers, operating systems or npm packages (report them upstream, and
  tell us if the SDK's use makes the impact worse);
- test-only tools and mocks that cannot be reached through the published package;
- denial-of-service reports that require control of the user's machine or network;
- social engineering, phishing and physical attacks.

If you are unsure which repository owns an issue, report it here privately and we will route it.

## Research safety

We support good-faith security research. Do not:

- access funds, keys or data that are not yours;
- test against mainnet with real user funds;
- degrade a service, run denial-of-service tests or send high-volume traffic;
- use social engineering, phishing or physical access;
- publish exploit details before a coordinated disclosure date.

Use a local chain, testnet or the project's local stand. Stop testing and report immediately if you encounter real
user data or funds. We will not pursue legal action for good-faith research that follows this policy; this safe
harbor does not cover extortion, data theft, disruption or attacks on third parties.

## No bug bounty

There is currently no paid bug bounty. We still credit responsible reports in the advisory and release notes when
the reporter agrees.

## Security releases

Confirmed issues are fixed privately, covered by a regression test where possible, released through the normal
protected release process, and described in a GitHub Security Advisory. The advisory names the affected versions,
the fixed version and any required integrator action. Integrators should watch the repository's security advisories
and release notes rather than relying on a public issue.
