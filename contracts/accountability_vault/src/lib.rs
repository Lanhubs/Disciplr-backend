use soroban_sdk::{contracterror, contractimpl, contracttype, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub struct Milestone {
    pub verified: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    TooManyMilestones = 1,
}

/// Upper bound for `create_vault` milestone count to keep per-call loops bounded.
pub const MAX_MILESTONES: u32 = 32;

pub struct AccountabilityVaultContract;

#[contractimpl]
impl AccountabilityVaultContract {
    pub fn create_vault(_env: Env, milestones: Vec<Milestone>) -> Result<(), ContractError> {
        if milestones.len() > MAX_MILESTONES {
            return Err(ContractError::TooManyMilestones);
        }

        Ok(())
    }

    pub fn all_verified(_env: Env, milestones: Vec<Milestone>) -> bool {
        let mut i = 0;
        while i < milestones.len() {
            if !milestones.get(i).unwrap().verified {
                return false;
            }
            i += 1;
        }
        true
    }

    pub fn any_verified(_env: Env, milestones: Vec<Milestone>) -> bool {
        let mut i = 0;
        while i < milestones.len() {
            if milestones.get(i).unwrap().verified {
                return true;
            }
            i += 1;
        }
        false
    }
}

#[cfg(test)]
mod test;
