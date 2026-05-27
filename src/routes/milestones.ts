import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireUser, requireVerifier } from '../middleware/rbac.js'
import {
  createMilestone,
  getMilestonesByVaultId,
  getMilestoneById,
  verifyMilestone,
  validateMilestone,
  allMilestonesVerified,
} from '../services/milestones.js'
import { completeVault } from '../services/vaultTransitions.js'
import { vaults } from './vaults.js'
import { AppError } from '../middleware/errorHandler.js'

export const milestonesRouter = Router({ mergeParams: true })

// POST /api/vaults/:vaultId/milestones
milestonesRouter.post('/', authenticate, requireUser, (req: Request, res: Response, next: NextFunction) => {
  const { vaultId } = req.params
  const vault = vaults.find((v) => v.id === vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  if (vault.status !== 'active') {
    return next(AppError.conflict('Cannot add milestones to a non-active vault'))
  }

  const { description } = req.body as { description?: string }
  if (!description?.trim()) {
    return next(AppError.badRequest('description is required'))
  }

  const milestone = createMilestone(vaultId, description.trim(), vault.verifier)
  res.status(201).json(milestone)
})

// GET /api/vaults/:vaultId/milestones
milestonesRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  const { vaultId } = req.params
  const vault = vaults.find((v) => v.id === vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestones = getMilestonesByVaultId(vaultId)
  res.json({ milestones })
})

// PATCH /api/vaults/:vaultId/milestones/:id/verify
milestonesRouter.patch('/:id/verify', authenticate, requireVerifier, (req: Request, res: Response, next: NextFunction) => {
  const { vaultId, id } = req.params

  const vault = vaults.find((v) => v.id === vaultId)
  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestone = getMilestoneById(id)
  if (!milestone || milestone.vaultId !== vaultId) {
    return next(AppError.notFound('Milestone not found'))
  }

  const verified = verifyMilestone(id)
  if (!verified) {
    return next(AppError.notFound('Milestone not found'))
  }

  let vaultCompleted = false
  if (allMilestonesVerified(vaultId) && vault.status === 'active') {
    const result = completeVault(vaultId)
    vaultCompleted = result.success
  }

  res.json({ milestone: verified, vaultCompleted })
})

const EVIDENCE_HASH_RE = /^[0-9a-f]{32,128}$/i

// POST /api/vaults/:vaultId/milestones/:id/validate
milestonesRouter.post('/:id/validate', authenticate, requireVerifier, (req: Request, res: Response, next: NextFunction) => {
  const { vaultId, id } = req.params
  const validatorUserId = req.user!.userId
  const { evidenceHash } = req.body as { evidenceHash?: string }

  if (!evidenceHash || !evidenceHash.trim()) {
    return next(AppError.badRequest('evidenceHash is required'))
  }

  const cleanEvidenceHash = evidenceHash.trim().toLowerCase()
  if (!EVIDENCE_HASH_RE.test(cleanEvidenceHash)) {
    return next(AppError.validation('evidenceHash must be a valid hex string (32–128 characters)'))
  }

  const vault = vaults.find((v) => v.id === vaultId)
  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestone = getMilestoneById(id)
  if (!milestone || milestone.vaultId !== vaultId) {
    return next(AppError.notFound('Milestone not found'))
  }

  const result = validateMilestone(id, validatorUserId, cleanEvidenceHash)
  if (!result.success) {
    if (result.error === 'Milestone already validated') {
      return next(AppError.conflict('Milestone already validated'))
    }
    if (result.error === 'Unauthorized: only assigned verifier can validate') {
      return next(AppError.forbidden('Unauthorized: only assigned verifier can validate'))
    }
    return next(AppError.badRequest(result.error!))
  }

  let vaultCompleted = false
  if (allMilestonesVerified(vaultId) && vault.status === 'active') {
    const result = completeVault(vaultId)
    vaultCompleted = result.success
  }

  res.json({ milestone: result.milestone, vaultCompleted })
})
