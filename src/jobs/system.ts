import { createDefaultJobHandlers } from './handlers.js'
import { InMemoryJobQueue, type QueueMetrics, type QueuedJobReceipt } from './queue.js'
import { type EnqueueOptions, type JobPayloadByType, type JobType } from './types.js'
import { recoverPendingExportJobs } from '../services/exportQueue.js'
import {
  createNotificationService,
  type NotificationService,
} from '../services/notifications/factory.js'
import db from '../db/index.js'
import { getPgPool } from '../db/pool.js'

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

/**
 * Generates a deterministic advisory lock key from a job name string.
 * Uses a simple hash to convert the string to two 32-bit integers for PostgreSQL advisory locks.
 */
function jobNameToAdvisoryLockKey(jobName: string): [number, number] {
  let h1 = 0xdeadbeef
  let h2 = 0xcafebabe
  for (let i = 0; i < jobName.length; i++) {
    h1 = Math.imul(31, h1) + jobName.charCodeAt(i)
    h2 = Math.imul(17, h2) + jobName.charCodeAt(i)
  }
  return [h1 | 0, h2 | 0]
}

interface ScheduledJobConfig {
  name: string
  intervalMs: number
  execute: () => Promise<void> | void
  immediate?: boolean
  initialDelayMs?: number
}

class SchedulerRegistry {
  private readonly scheduledJobs: Map<string, ScheduledJobConfig> = new Map()
  private readonly timers: Map<string, NodeJS.Timeout> = new Map()
  private readonly runningJobs: Set<string> = new Set()

  registerJob(config: ScheduledJobConfig): void {
    this.scheduledJobs.set(config.name, config)
  }

  async tryAcquireLock(jobName: string): Promise<boolean> {
    const pool = getPgPool()
    if (!pool) {
      return true
    }

    const [key1, key2] = jobNameToAdvisoryLockKey(jobName)
    const client = await pool.connect()
    try {
      const result = await client.query(
        'SELECT pg_try_advisory_lock($1, $2) as acquired',
        [key1, key2]
      )
      return result.rows[0].acquired as boolean
    } catch (error) {
      console.error(`[SchedulerRegistry] Failed to acquire advisory lock for ${jobName}:`, error)
      return false
    } finally {
      client.release()
    }
  }

  async releaseLock(jobName: string): Promise<void> {
    const pool = getPgPool()
    if (!pool) {
      return
    }

    const [key1, key2] = jobNameToAdvisoryLockKey(jobName)
    const client = await pool.connect()
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [key1, key2])
    } catch (error) {
      console.error(`[SchedulerRegistry] Failed to release advisory lock for ${jobName}:`, error)
    } finally {
      client.release()
    }
  }

  private async runJobWithOverlapGuard(config: ScheduledJobConfig): Promise<void> {
    if (this.runningJobs.has(config.name)) {
      console.log(`[SchedulerRegistry] Job ${config.name} already running locally, skipping`)
      return
    }

    const lockAcquired = await this.tryAcquireLock(config.name)
    if (!lockAcquired) {
      console.log(`[SchedulerRegistry] Could not acquire lock for ${config.name}, skipping (another replica holds the lock)`)
      return
    }

    this.runningJobs.add(config.name)
    const now = new Date()
    try {
      await config.execute()
      await db('scheduler_heartbeats')
        .insert({
          name: config.name,
          last_run_at: now,
        })
        .onConflict('name')
        .merge({
          last_run_at: now,
        })
    } catch (error) {
      console.error(`[SchedulerRegistry] Job ${config.name} failed:`, error)
    } finally {
      this.runningJobs.delete(config.name)
      await this.releaseLock(config.name)
    }
  }

  start(): void {
    for (const config of this.scheduledJobs.values()) {
      if (config.immediate) {
        const delay = config.initialDelayMs ?? 0
        setTimeout(() => {
          void this.runJobWithOverlapGuard(config)
        }, delay)
      }

      const timer = setInterval(() => {
        void this.runJobWithOverlapGuard(config)
      }, config.intervalMs)

      if (typeof timer.unref === 'function') {
        timer.unref()
      }

      this.timers.set(config.name, timer)
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
  }
}

export class BackgroundJobSystem {
  private readonly queue: InMemoryJobQueue
  private readonly schedulerRegistry: SchedulerRegistry
  private started = false
  private shuttingDown = false

  constructor(notificationService?: NotificationService) {
    this.queue = new InMemoryJobQueue({
      concurrency: parsePositiveInteger(process.env.JOB_WORKER_CONCURRENCY, 2),
      pollIntervalMs: parsePositiveInteger(process.env.JOB_QUEUE_POLL_INTERVAL_MS, 250),
      historyLimit: parsePositiveInteger(process.env.JOB_HISTORY_LIMIT, 50),
    })
    this.schedulerRegistry = new SchedulerRegistry()

    const resolvedNotificationService =
      notificationService ?? createNotificationService(process.env.NOTIFICATION_PROVIDER ?? 'console')
    const handlers = createDefaultJobHandlers(resolvedNotificationService)

    this.queue.registerHandler('notification.send', handlers['notification.send'])
    this.queue.registerHandler('deadline.check', handlers['deadline.check'])
    this.queue.registerHandler('oracle.call', handlers['oracle.call'])
    this.queue.registerHandler('analytics.recompute', handlers['analytics.recompute'])
    this.queue.registerHandler('export.generate', handlers['export.generate'])
    this.queue.registerHandler('sessions.cleanup', handlers['sessions.cleanup'])
  }

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.shuttingDown = false
    this.queue.start()
    this.scheduleRecurringJobs()
    this.schedulerRegistry.start()
    void recoverPendingExportJobs(this).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[jobs:export.generate] failed to recover pending exports: ${message}`)
    })
  }

  async stop(): Promise<void> {
    this.shuttingDown = true
    this.schedulerRegistry.stop()
    this.started = false
    await this.queue.stop()
  }

  enqueue(
    type: JobType,
    payload: JobPayloadByType[JobType],
    options: EnqueueOptions = {},
  ): QueuedJobReceipt<JobType> {
    if (this.shuttingDown) {
      throw new Error('Cannot enqueue job: system is shutting down')
    }
    return this.queue.enqueue(type, payload, options)
  }

  getDeadLetters() {
    return this.queue.getDeadLetters()
  }

  getDeadLetter(jobId: string) {
    return this.queue.getDeadLetter(jobId)
  }

  replayDeadLetter(jobId: string): QueuedJobReceipt<JobType> {
    if (this.shuttingDown) {
      throw new Error('Cannot replay dead-letter job: system is shutting down')
    }
    return this.queue.replayDeadLetter(jobId)
  }

  retryJob(jobId: string, force: boolean = false): QueuedJobReceipt<JobType> {
    if (this.shuttingDown) {
      throw new Error('Cannot retry job: system is shutting down')
    }
    return this.queue.retryJob(jobId, force)
  }

  getMetrics(): QueueMetrics {
    return this.queue.getMetrics()
  }

  private scheduleRecurringJobs(): void {
    if (process.env.ENABLE_JOB_SCHEDULER === 'false') {
      return
    }

    const deadlineCheckIntervalMs = parsePositiveInteger(
      process.env.DEADLINE_CHECK_INTERVAL_MS,
      60_000,
    )
    const analyticsIntervalMs = parsePositiveInteger(
      process.env.ANALYTICS_RECOMPUTE_INTERVAL_MS,
      300_000,
    )
    const sessionsCleanupIntervalMs = parsePositiveInteger(
      process.env.SESSIONS_CLEANUP_INTERVAL_MS,
      86_400_000, // 24 hours
    )

    this.schedulerRegistry.registerJob({
      name: 'deadline.check',
      intervalMs: deadlineCheckIntervalMs,
      immediate: true,
      execute: () => {
        this.enqueue('deadline.check', { triggerSource: 'scheduler' })
      },
    })

    this.schedulerRegistry.registerJob({
      name: 'analytics.recompute',
      intervalMs: analyticsIntervalMs,
      immediate: true,
      initialDelayMs: 5_000,
      execute: () => {
        this.enqueue('analytics.recompute', {
          scope: 'global',
          reason: this.started ? 'scheduled-refresh' : 'startup-bootstrap',
        })
      },
    })

    this.schedulerRegistry.registerJob({
      name: 'sessions.cleanup',
      intervalMs: sessionsCleanupIntervalMs,
      immediate: true,
      initialDelayMs: 10_000,
      execute: () => {
        this.enqueue('sessions.cleanup', {})
      },
    })
  }
}
