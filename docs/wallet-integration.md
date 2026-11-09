# Wallet and operator integration

This change adds NEAR Connect 0.12.0 and an operator review workbench to Developers. The top bar exposes wallet access and Effects on every page. The existing visual identity and generated backgrounds are preserved.

## Real current state

On 8 November 2026 the running backend reported a matching mainnet RPC connection. Repository config contains public network examples, but no populated testnet contract/agent configuration or saved deployment transaction receipt was found. A healthy RPC is not evidence that PHOENIX contracts were deployed. No account creation, deployment, wallet connection, signature or blockchain transaction was performed by the coding agent.

## Available workflow

1. Connect a supported NEAR wallet through NEAR Connect. No access-key scope or automatic connection is requested. The connector isolates wallet execution; remotely maintained wallet integrations remain an external trust dependency.
2. Inspect policy readiness. Configure a reviewed deployed Core account and its exact on-chain code hash on the backend.
3. Prepare one bounded action: heartbeat as the registered operator of a live Running agent, or report_crash when its heartbeat is expired. This first release does not expose arbitrary methods, transfers, payment settlement, contract deployment or escrow mutation.
4. Review signer, receiver, method, arguments, network, zero attached deposit, 30 Tgas gas cap, code hash and the observed finalized block. Reviews expire after 30 seconds.
5. Recheck the same action against fresh on-chain state and re-read wallet accounts immediately before requesting wallet approval. Account, network, epoch, contract and form changes invalidate the review. Mainnet also requires typing the exact signer account.
6. The wallet signs and submits only after the human approves it. A returned hash is not displayed as success. RPC tx lookup requests FINAL and checks signer, network and receiver; receipt failures are surfaced. No automatic retries run.
7. The latest returned hash is retained locally for manual verification. Export the receipt and its RPC observation as JSON. These are RPC observations, not independent cryptographic proofs or an audit.

## Testnet setup

Deploy and initialize the existing reviewed Core contract to an account you control on testnet, then register the agent with its intended operator. These deployment steps require a testnet signer, account choices and wallet approval; the app does not create them automatically. Never use example IDs as evidence of a real deployment.

Set these values in the environment of the backend process (the .env.example files are documentation; they are not automatically loaded):

    NEAR_NETWORK=testnet
    NEAR_RPC_URL=https://rpc.testnet.near.org
    PHOENIX_ENABLE_WALLET_ACTIONS=true
    PHOENIX_CORE_ID=<actual deployed Core account>
    PHOENIX_CORE_CODE_HASH=<exact code_hash returned for that deployed account>

Set NEXT_PUBLIC_PHOENIX_AGENT_ID on the dashboard if you want its agent field prefilled. Existing contract-state lookup also uses NEXT_PUBLIC_PHOENIX_CORE_ID, NEXT_PUBLIC_REWIND_VAULT_ID and NEXT_PUBLIC_PHOENIX_TASK_ID. Empty values keep those views unavailable.

Restart the backend after changing its environment and restart/rebuild the dashboard after NEXT_PUBLIC changes. Connect the registered operator's testnet wallet, inspect & prepare, review, and approve one heartbeat. Verify the final receipt and updated contract state. Then exercise wallet rejection, account changes, RPC outage, code mismatch, contract pause and stale review states.

## Mainnet boundary

Mainnet actions are disabled unless both PHOENIX_ENABLE_WALLET_ACTIONS=true and PHOENIX_ENABLE_MAINNET_ACTIONS=reviewed are explicitly set alongside the deployed Core account and pinned code hash. This enables the same two bounded operator actions, not deployments, recovery authorization, spending or settlement. Mainnet deployment and real-fund use require independent contract/dependency review and user-controlled signatures. The backend holds no private keys and never broadcasts transactions.

## Security remediation

The old bundled @near-wallet-selector / Meteor SDK dependency tree produced 18 npm audit entries (5 high, 13 low). It is removed from the project manifest and lockfile and replaced with pinned @hot-labs/near-connect 0.12.0. The refreshed workspace package-lock audit reports zero known vulnerabilities on this date. That is a registry audit result, not a cryptographic security certification. Previous dependency-security-review.md is historical.

The RPC decoder now distinguishes structured account/key responses from call_function result bytes, and rejects malformed forms. Access-key preflight now requests the same pinned block as the other observations. RPC ISO timestamps are converted to nanoseconds without losing fractional precision. Transaction outcome reads use tx with wait_until=FINAL.

## Button and cursor effects

Effects opens motion preferences from the top bar. Adaptive follows the device preference. Still pauses effects. Vivid is an explicit local opt-in to pointer motion even if the device prefers reduced motion. Touch remains free of a custom cursor. Primary controls have spring zoom and magnetic movement; other action controls gain visible proximity movement, cyan glow, color change, sheen and pressed feedback. Background images remain static.

## Validation and limits

This implementation-state report predates the final release-candidate run.
For current contract, backend, recovery-service, wallet, Sandbox, build and
dependency-audit results, see [test evidence](test-evidence.md) and the
[Grand Prize release report](GRAND-PRIZE-RELEASE-REPORT.md). No real wallet
approval or deployed testnet transaction has been verified. Browser-based
desktop/mobile verification remains blocked by missing Chromium system
libraries in the current environment.

Sources: https://docs.near.org/api/rpc/contracts ; https://github.com/near/wallet-selector ; https://github.com/azbang/near-connect ; https://nearhackathon.com/
