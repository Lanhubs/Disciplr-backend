# Disciplr Soroban Contracts

On-chain programmable, time-locked capital vaults for accountability staking,
the chain-side counterpart to the `disciplr-backend` API and Horizon listener.

## Workspace layout

```text
contracts/
├── Cargo.toml                       # workspace manifest (soroban-sdk = "23")
├── README.md
└── accountability_vault/
    ├── Cargo.toml
    └── src/
        ├── lib.rs                   # AccountabilityVault contract
        └── test.rs                  # unit tests (testutils)
```

## accountability_vault

Implements the vault lifecycle that the backend models off-chain in
`src/services/vaultTransitions.ts` and parses events for in
`src/services/eventParser.ts`:

| Function | Purpose |
|---|---|
| `init` | Initialize the deployment admin that manages instance-level policy. Must be called once before allowlist administration. |
| `set_admin` | Rotate the deployment admin. Only the current admin may call this. |
| `set_allowed_token` | Add or remove a SEP-41 token contract from the instance-level allowlist used for new vaults. |
| `is_allowed_token` | Read whether a token contract is currently allowed for new vault creation. |
| `create_vault` | Create a `Draft` vault with milestones, verifier, token, and success/failure destinations. Validates amount, deadline, milestone sums, and that the requested token is allowlisted. |
| `stake` | Creator transfers the SEP-41 token into the contract; `Draft` -> `Active`. |
| `check_in` | Designated verifier confirms a milestone before its `due_date`. |
| `slash_on_miss` | After the deadline with unverified milestones, slash funds to `failure_destination`; `Active` -> `Failed`. |
| `claim` | When all milestones are verified, release funds to `success_destination`; `Active` -> `Completed`. |
| `withdraw` | Cancel/refund an unfunded or unstarted vault to the creator; -> `Cancelled`. |
| `get_vault` | Read-only accessor for the current vault record. |
| `get_unverified_milestone_indices` | Returns `Vec<u32>` of indices for milestones that have not yet been verified, in ascending order. Used by the keeper job (`src/jobs/handlers.ts`) to determine slash targets without loading and filtering the full vault client-side. |

### Token allowlist policy

`accountability_vault` enforces a deployment-wide token allowlist at vault
creation time. The admin initializes the contract with `init`, then uses
`set_allowed_token(admin, token, true)` to permit curated SEP-41 token
contracts (for example an XLM SAC or approved USDC contract) and
`set_allowed_token(admin, token, false)` to remove them. `create_vault` checks
the selected token against the instance-level `AllowedToken(token)` storage
entry and returns `Error::TokenNotAllowed` when the token is absent or has been
removed. Removing a token only blocks future vault creation; existing vault
records retain their configured token so already-created vaults can continue
their lifecycle.

The `VaultStatus` enum (`Draft`/`Active`/`Completed`/`Failed`/`Cancelled`)
mirrors `PersistedVault.status` in `src/types/vaults.ts`. Emitted events
(`vault_created`, `vault_staked`, `milestone_checked_in`, `vault_slashed`,
`vault_completed`, `vault_cancelled`, `vault_withdrawn`) align with the topics
consumed by the backend event parser.

**Error Handling and Backend Recoverability:**
Contract read operations (like `get_vault`) and state transitions (`stake`, `check_in`, `claim`) safely return `Error::NotInitialized` rather than panicking when a `vault_id` is unset in storage. The backend's `src/middleware/errorHandler.ts` relies on this typed error mapping (specifically to `ErrorCode.NOT_FOUND` with status code 404) to gracefully recover from pre-initialization read attempts.

## Build & test

```bash
# from the contracts/ directory
stellar contract build
cargo test

# Check that the compiled contract stays within the allowed size budget
# Fails if the .wasm artifact exceeds the 100KB budget (configurable via MAX_WASM_SIZE)
bash build-size-check.sh
```

### Wasm Size Budget Configuration

To prevent accidental bloat in the smart contract, the `accountability_vault` includes a size budget check (`build-size-check.sh`) integrated into the CI pipeline.
The default limit is set to **100,000 bytes** (~100KB).

If you need to update this budget as the contract grows:

1. Temporarily increase the budget locally by exporting the variable: `export MAX_WASM_SIZE=150000`
2. Update the default value in `contracts/build-size-check.sh`
3. Push the changes to update the CI limit.

## Backend integration

`src/services/soroban.ts` calls `create_vault` via the Stellar SDK
(`@stellar/stellar-sdk` v14). The Horizon listener
(`src/services/horizonListener.ts`) and `src/services/eventParser.ts`
ingest the events emitted by these functions to keep the off-chain vault state
in sync.

## Internal Helpers

The contract includes several optimized internal helper functions to guarantee security, modularity, and easy auditability:

| Helper | Purpose |
|---|---|
| `assert_active(&Vault)` | Centralizes repeated state validation checks for `Active` vaults in `slash_on_miss`, `claim`, and `withdraw`, making future status lifecycle additions single-point-of-change updates. |

