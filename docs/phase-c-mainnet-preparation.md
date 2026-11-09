# Phase C: NEAR mainnet integration preparation

## Network separation and read-only data

The backend has independent `localnet`, `testnet`, and `mainnet` RPC profiles in `config/networks/`. Remote profiles require HTTPS and the matching NEAR RPC hostname. Localnet requires loopback HTTP. Before returning reads, the backend asks the endpoint for its `chain_id` and rejects a network mismatch.

The `/api/network/health`, `/account`, `/contract-state`, and `/transaction` routes are read-only. Finalized account and contract reads include the observed block height/hash; multi-contract state queries are pinned to one block and reject inconsistent results. This is a trusted RPC observation, not an independently verified Merkle proof. Transaction lookup requires a canonical-looking hash and sender account, then confirms the returned transaction identity matches both before offering a network-specific explorer URL. Localnet has no public explorer link.

The existing dashboard demo and PHOENIX Control Plane remain separate. The demo still uses ephemeral local sandbox accounts. Mainnet telemetry must never be inferred from demo events. `readControlState` remains localnet-only, so the local recovery dashboard does not silently switch its sandbox state cards to public chain data.

## Current wallet connector limitation

The browser wallet connector is not installed in this checkout. The attempted install of the official NEAR Wallet Selector packages failed because this environment could not resolve `registry.npmjs.org` (`EAI_AGAIN`). No custom signing protocol or key entry form was substituted. The dashboard explicitly reports wallet connection/signing as unavailable. Once DNS is restored, install a reviewed, pinned official Wallet Selector connector and add its resolved package-lock entries before enabling wallet connection. Signing must stay in the wallet and be initiated by a user gesture; the backend must never receive wallet seeds, private keys, or signed transaction bytes.

## Deployment preflight

`POST /api/network/deployment-preflight` is restricted to the trusted `http://localhost:3000` browser origin. It accepts only account IDs, a public ed25519 access key, and expected NEAR base58 code hashes. On explicitly selected mainnet it verifies the reported mainnet chain, the signer account and full-access public key, and both target account code hashes at a pinned finalized block. It reports whether targets are empty or already match the expected code hash. It does not build transactions, sign, broadcast, deploy, or request private credentials. A false result is a stop condition; a true result is permission to begin a human review only.

The HTTP server remains bound to `127.0.0.1`. Preflight POSTs require the trusted dashboard origin, content type and a small JSON body. Read-only GET APIs expose public chain data only. The demo process always sets its child environment to localnet.

## Restricted future mainnet deployment plan

No deployment has been performed. Before anyone authorizes one:

1. Complete wallet connection using a pinned, reviewed wallet connector; require the user to select mainnet in that wallet and display the signer, receiver accounts, actions, deposits and network before approval. The dashboard must not silently create an access key or assemble hidden actions.
2. Complete a separate testnet deployment and run the full sandbox/testnet adversarial suite against the exact release artifacts. Freeze and independently review the source revision, lockfiles, toolchain, optimized WASM checksums and contract state layout.
3. Use separate, dedicated contract accounts for PHOENIX Core and REWIND. Use a hardware wallet or organizational multisig for ownership and deployment; never use an agent key, SENTINEL key, treasury key, or a key stored by the backend.
4. Fund only those accounts that must pay deployment storage/gas. Calculate current storage and gas requirements immediately before the change, transfer the minimum with a small operator-approved margin, and keep unrelated user or treasury balances elsewhere. Do not rely on a stale fixed NEAR amount.
5. Run the read-only preflight against finalized mainnet state. Independently compare the public signer key, ownership/multisig policy, both account IDs, artifact hashes, RPC chain ID, initial contract state, Guardian/Sentinel identities, backup registry, and emergency pause/recovery procedures.
6. Require two-person approval of the exact actions and amounts in the wallet prompt. Deploy one contract at a time. Record actual signed transaction hashes and final outcomes from RPC, then verify code hashes and initialized state at finalized blocks before proceeding.
7. Keep settlement disabled and do not fund REWIND with task escrow until independent reviewers approve the deployed code hashes, account permissions, recovery controls, and operational monitoring. Stop if any hash, account, chain ID, permission, or state differs.

The repository contains no mainnet broadcast/deployment command. Do not add or run one without explicit authorization. No mainnet deployment, wallet connection, funds, or public transaction was used for Stage C development.

## Validation

Backend tests use deterministic mock RPC responses; they cover endpoint/network mismatches, malformed account IDs, missing contract code, pinned finalized state, forged transaction identity, explorer URL gating, full-access key preflight, non-mainnet preflight rejection, and unauthorized HTTP origins. They do not prove the live mainnet endpoint is available from this WSL environment or validate live contract deployment state.
