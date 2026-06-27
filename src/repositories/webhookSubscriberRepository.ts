import { Knex } from 'knex'
import type { WebhookSubscriber } from '../services/webhooks.js'

interface SubscriberRow {
  id: string
  organization_id: string
  url: string
  secret: string
  previous_secret: string | null
  rotated_at: Date | null
  events: string[]
  active: boolean
  created_at: Date
  updated_at: Date
}

function toSubscriber(row: SubscriberRow): WebhookSubscriber {
  return {
    id: row.id,
    organizationId: row.organization_id,
    url: row.url,
    secret: row.secret,
    previousSecret: row.previous_secret ?? null,
    rotatedAt: row.rotated_at instanceof Date
      ? row.rotated_at.toISOString()
      : (row.rotated_at ? String(row.rotated_at) : null),
    events: row.events ?? [],
    active: row.active,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

export class WebhookSubscriberRepository {
  constructor(private readonly db: Knex) {}

  async findByOrg(organizationId: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async findById(id: string): Promise<WebhookSubscriber | null> {
    const row = await this.db<SubscriberRow>('webhook_subscribers').where({ id }).first()
    return row ? toSubscriber(row) : null
  }

  async findByEvent(organizationId: string, eventType: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .andWhere(function () {
        this.whereRaw("events = '[]'::jsonb").orWhereRaw('events @> ?', [
          JSON.stringify([eventType]),
        ])
      })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async create(data: {
    organizationId: string
    url: string
    secret: string
    events: string[]
  }): Promise<WebhookSubscriber> {
    const [row] = await this.db<SubscriberRow>('webhook_subscribers')
      .insert({
        organization_id: data.organizationId,
        url: data.url,
        secret: data.secret,
        events: JSON.stringify(data.events) as any,
      })
      .returning('*')
    return toSubscriber(row)
  }

  /**
   * Idempotent upsert keyed on (organization_id, url).
   *
   * - If no row exists for the (org, url) pair a new subscriber is inserted.
   * - If a row already exists the `secret`, `events`, and `active` fields are
   *   updated in-place so the caller does not end up with duplicate rows.
   * - Cross-org overwrites are impossible: the WHERE clause in the ON CONFLICT
   *   DO UPDATE is scoped to the same organization_id.
   *
   * The secret material in the response is intentionally included so callers
   * that manage secrets (e.g., the admin service) can confirm what was stored.
   * List endpoints must strip the secret before returning to API consumers.
   */
  async upsert(data: {
    organizationId: string
    url: string
    secret: string
    events: string[]
  }): Promise<WebhookSubscriber> {
    const [row] = await this.db
      .raw<{ rows: SubscriberRow[] }>(
        `
        INSERT INTO webhook_subscribers (organization_id, url, secret, events, active)
        VALUES (:organizationId, :url, :secret, :events::jsonb, true)
        ON CONFLICT (organization_id, url)
        DO UPDATE SET
          secret     = EXCLUDED.secret,
          events     = EXCLUDED.events,
          active     = true,
          updated_at = now()
        WHERE webhook_subscribers.organization_id = :organizationId
        RETURNING *
        `,
        {
          organizationId: data.organizationId,
          url: data.url,
          secret: data.secret,
          events: JSON.stringify(data.events),
        },
      )
      .then((result) => result.rows)

    return toSubscriber(row)
  }

  /**
   * Rotates the signing secret for a subscriber.
   *
   * The current secret is moved to `previous_secret` and `rotated_at` is
   * stamped to now so the delivery layer can honour the grace window.
   * The new secret begins signing immediately; the previous secret remains
   * valid for verification until the grace window closes.
   *
   * Returns `null` if the subscriber does not exist or belongs to a different
   * organization (cross-org rotation is rejected silently to avoid enumeration).
   */
  async rotateSecret(
    id: string,
    organizationId: string,
    newSecret: string,
  ): Promise<WebhookSubscriber | null> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ id, organization_id: organizationId })
      .update({
        previous_secret: this.db.raw('secret'),
        secret: newSecret,
        rotated_at: this.db.fn.now(),
        updated_at: this.db.fn.now(),
      })
      .returning('*')

    if (rows.length === 0) return null
    return toSubscriber(rows[0])
  }

  async deactivate(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers')
      .where({ id })
      .update({ active: false, updated_at: this.db.fn.now() })
    return count > 0
  }

  async remove(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers').where({ id }).del()
    return count > 0
  }
}
