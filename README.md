# PHOENIX on Solana

PHOENIX is a recovery and evidence console for autonomous agent tasks. This Solana release candidate includes the product interface, Wallet Standard account reads and a native Rust Solana program for task lifecycle and SOL escrow. The original hackathon implementation is available in the repository history. The active dashboard workspace and Cargo workspace build the Solana release candidate.

## Run the console

Requirements are Node 22 or later and npm. From the repository root:

    npm ci --ignore-scripts
    npm test
    npm run typecheck
    npm run dev

Open the URL printed by Next.js under /near-phoenix/. The console reads finalized Solana account state. The Projects workspace provides customer intake, agent artifacts, and delivery approval when served with the production Worker. See [the production deployment runbook](apps/production/DEPLOYMENT.md).

The wallet page discovers browser wallets that implement Wallet Standard. It requests only wallet connection and displays the public address, SOL balance and finalized slot. The balance read sends the public address to PublicNode. No recovery or payment operation is sent from that page.

## Build and verify the Solana program

    cargo test --locked -p phoenix-solana-program
    cargo build-sbf --manifest-path programs/phoenix/Cargo.toml
    cargo run --locked --quiet -p phoenix-solana-program --example recovery_drill

To rerun the Windows/Ubuntu validator test, place the Agave CLI in local-tools/solana-release and the compiled program in local-tools/sbf. Install the isolated test client with npm install --prefix local-tools/validator-js --ignore-scripts @solana/web3.js@1.98.4 and run node scripts/test-solana-validator.mjs.

The last Cargo command exercises a local-only fixture for protocol development. The production dashboard uses finalized RPC data rather than the fixture. See programs/phoenix/src/state.rs for transitions and programs/phoenix/src/lib.rs for signer, PDA and lamport enforcement.

The task is derived from the seeds task, owner public key and a caller-generated 32-byte task ID. The task account holds the funded native SOL principal in addition to its rent reserve. Distinct operator, backup, owner, guardian and Sentinel keys define the authority boundaries. A recovery consumes the Sentinel's approval, changes the operator, and advances the execution generation. A payout requires the current generation, exact checkpoint digest and amount, unexpired approval, next nonce, and authorization co-signed by the Sentinel and funding owner. A refund closes a crashed or quarantined task.

## Build for hosting

Set NEXT_PUBLIC_PHOENIX_DEVNET_PROGRAM and, after mainnet deployment, NEXT_PUBLIC_PHOENIX_MAINNET_PROGRAM to the program IDs you have reviewed on those networks. Then run:

    npm run build
    node scripts/verify-static-export.mjs

Publish apps/solana-dashboard/out at the /near-phoenix/ base path. The task explorer accepts a task account address for the configured program and checks the network fingerprint, account owner, account tag and finalized RPC response. Use a dedicated RPC for a public production rollout where availability matters.

## Release readiness

The compiled program passed a local Agave validator test on disposable accounts. The test initializes a pre-funded task account, rejects unauthorized, stale and duplicate actions, recovers to a new generation, settles an approved amount and refunds the remainder. Verify a devnet deployment before considering mainnet. The account explorer and wallet reads are the shipped browser workload. Signing operator actions from the browser and integrating a live worker that restores checkpoint bytes require a separate integration pass. Audit the program, identify signers and authority custody, configure durable deployment and monitoring, and test recovery and escrow invariants before using real funds.
