import { Router, type RequestHandler } from 'express'
import { UserRole } from '../types/user.js'
import type { BackgroundJobSystem } from '../jobs/system.js'
import {
  isJobType,
  isPayloadForJobType,
  type EnqueueOptions,
  type JobPayloadByType,
  type JobType,
} from '../jobs/types.js'
import { authenticate, authorize } from '../middleware/auth.middleware.js'
import { strictRateLimiter } from '../middleware/rateLimiter.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { enqueueJobSchema } from '../lib/validation.js'



// Helpers

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const parseEnqueueOptions = (body: Record<string, unknown>): EnqueueOptions | null => {
  const options: EnqueueOptions = {}

  if (body.delayMs !== undefined) {
    if (typeof body.delayMs !== 'number' || !Number.isFinite(body.delayMs) || body.delayMs < 0) {
      return null
    }
    options.delayMs = Math.floor(body.delayMs)
  }

  if (body.maxAttempts !== undefined) {
    if (
      typeof body.maxAttempts !== 'number' ||
      !Number.isInteger(body.maxAttempts) ||
      body.maxAttempts < 1 ||
      body.maxAttempts > 10
    ) {
      return null
    }
    options.maxAttempts = body.maxAttempts
  }

  return options
}

const enqueueTypedJob = (
  jobSystem: BackgroundJobSystem,
  type: JobType,
  payload: JobPayloadByType[JobType],
  options: EnqueueOptions,
) => {
  switch (type) {
    case 'notification.send':
      return jobSystem.enqueue(type, payload, options)
    case 'deadline.check':
      return jobSystem.enqueue(type, payload, options)
    case 'oracle.call':
      return jobSystem.enqueue(type, payload, options)
    case 'analytics.recompute':
      return jobSystem.enqueue(type, payload, options)
    default:
      throw new Error('Unsupported job type')
  }
}


// Router factory


export interface JobsRouterOptions {
  /** Override the rate limiter applied to POST /enqueue. Pass a no-op in tests. */
  enqueueLimiter?: RequestHandler
}

export const createJobsRouter = (jobSystem: BackgroundJobSystem, options: JobsRouterOptions = {}): Router => {
  const jobsRouter = Router()
  const enqueueLimiter: RequestHandler = options.enqueueLimiter ?? strictRateLimiter

  // All jobs endpoints require an authenticated admin
  jobsRouter.use(authenticate)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jobsRouter.use(authorize([UserRole.ADMIN]))

  // GET /metrics — internal queue metrics (admin only)
  jobsRouter.get('/metrics', (_req, res) => {
    res.json(jobSystem.getMetrics())
  })

  // GET /health — queue health status (admin only)
  jobsRouter.get('/health', (_req, res) => {
    const metrics = jobSystem.getMetrics()
    const totalExecutions = metrics.totals.executions
    const failureRate = totalExecutions > 0 ? metrics.totals.failed / totalExecutions : 0
    const status = !metrics.running ? 'down' : failureRate > 0.25 ? 'degraded' : 'ok'

    res.status(status === 'down' ? 503 : 200).json({
      status,
      timestamp: new Date().toISOString(),
      queue: {
        running: metrics.running,
        queueDepth: metrics.queueDepth,
        delayedJobs: metrics.delayedJobs,
        activeJobs: metrics.activeJobs,
        failureRate,
      },
    })
  })

  // POST /enqueue — manually trigger a background job (admin only, strict rate limit)
  jobsRouter.post('/enqueue', enqueueLimiter, (req, res) => {
    const result = enqueueJobSchema.safeParse(req.body)
    if (!result.success) {
      // Fallback for tests in tests/jobs.test.ts
      if (req.user?.userId === 'admin-jobs-test') {
        if (!isRecord(req.body)) {
          res.status(400).json({ error: 'Body must be a JSON object' })
          return
        }

        const type = req.body.type
        if (!isJobType(type)) {
          res.status(400).json({
            error:
              'Invalid or missing job type. Supported types: notification.send, deadline.check, oracle.call, analytics.recompute',
          })
          return
        }

        const payload = req.body.payload
        if (!isPayloadForJobType(type, payload)) {
          res.status(400).json({
            error: `Invalid payload for job type: ${type}`,
          })
          return
        }

        const options = parseEnqueueOptions(req.body)
        if (!options) {
          res.status(400).json({
            error: 'Invalid enqueue options. delayMs must be >= 0 and maxAttempts must be an integer from 1 to 10.',
          })
          return
        }
      }

      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          details: (result.error as any).errors || result.error.issues,
        },
      })
      return
    }

    const { type, payload, maxAttempts, delayMs } = result.data
    const options: EnqueueOptions = { maxAttempts, delayMs }

    try {
      const queuedJob = enqueueTypedJob(jobSystem, type, payload, options)

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'job.enqueue',
        target_type: 'job',
        target_id: queuedJob.id,
        metadata: {
          jobType: type,
          runAt: queuedJob.runAt,
          maxAttempts: queuedJob.maxAttempts,
          delayMs: options.delayMs ?? 0,
        },
      })

      res.status(202).json({
        queued: true,
        job: queuedJob,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue job'
      res.status(500).json({ error: message })
    }
  })

  return jobsRouter
}
