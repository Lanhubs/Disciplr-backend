use soroban_sdk::{Env, Vec};

use crate::{AccountabilityVaultContract, ContractError, MAX_MILESTONES, Milestone};

#[test]
fn create_vault_rejects_more_than_max_milestones() {
    let env = Env::default();
    let mut milestones = Vec::new(&env);
    for _ in 0..(MAX_MILESTONES + 1) {
        milestones.push_back(Milestone { verified: false });
    }

    let result = AccountabilityVaultContract::create_vault(env.clone(), milestones);
    assert_eq!(result, Err(ContractError::TooManyMilestones));
}

#[test]
fn create_vault_allows_max_milestones() {
    let env = Env::default();
    let mut milestones = Vec::new(&env);
    for _ in 0..MAX_MILESTONES {
        milestones.push_back(Milestone { verified: false });
    }

    let result = AccountabilityVaultContract::create_vault(env.clone(), milestones);
    assert!(result.is_ok());
}
