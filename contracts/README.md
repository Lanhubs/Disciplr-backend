# Contracts

This folder contains smart contracts used by the Disciplr backend.

## accountability_vault

The `accountability_vault` contract caps the number of milestones accepted by `create_vault`.

- `MAX_MILESTONES = 32`
- `create_vault` rejects vault creation when `milestones.len() > MAX_MILESTONES`
- This bound protects per-call CPU/storage budgets for loops like `claim`, `slash_on_miss`, and `withdraw`
