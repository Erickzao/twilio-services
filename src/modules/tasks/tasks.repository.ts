import { types } from 'cassandra-driver';
import { getClient } from '@/database';
import type { CreateTaskInput, Task, TaskStatus } from '@/shared/types';

function normalizeLimit(limit: number, max = 1000): number {
  if (!Number.isFinite(limit)) return 100;
  const asInt = Math.floor(limit);
  if (asInt <= 0) return 100;
  return Math.min(asInt, max);
}

export class TasksRepository {
  private get client() {
    return getClient();
  }

  async findAll(limit = 100): Promise<Task[]> {
    const safeLimit = normalizeLimit(limit);
    const query = `SELECT * FROM tasks LIMIT ${safeLimit}`;
    const result = await this.client.execute(query);
    return result.rows.map(this.mapRowToTask);
  }

  async findByStatus(status: TaskStatus, limit = 100): Promise<Task[]> {
    const safeLimit = normalizeLimit(limit);
    const query = `SELECT * FROM tasks WHERE status = ? LIMIT ${safeLimit} ALLOW FILTERING`;
    const result = await this.client.execute(query, [status], {
      prepare: true,
    });
    return result.rows.map(this.mapRowToTask);
  }

  async findAssignedByCustomerContact(customerContact: string, limit = 25): Promise<Task[]> {
    const safeLimit = normalizeLimit(limit);
    const query = `SELECT * FROM tasks WHERE customer_contact = ? AND status = ? LIMIT ${safeLimit} ALLOW FILTERING`;
    const result = await this.client.execute(
      query,
      [customerContact, 'assigned' satisfies TaskStatus],
      { prepare: true },
    );
    return result.rows.map(this.mapRowToTask);
  }

  async findById(id: string): Promise<Task | null> {
    const query = 'SELECT * FROM tasks WHERE id = ?';
    const result = await this.client.execute(query, [types.Uuid.fromString(id)], { prepare: true });
    const row = result.rows[0];
    return row ? this.mapRowToTask(row) : null;
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const id = types.Uuid.random();
    const now = new Date();

    const query = `
      INSERT INTO tasks (id, customer_name, customer_contact, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    await this.client.execute(
      query,
      [id, input.customerName, input.customerContact, 'open' satisfies TaskStatus, now, now],
      { prepare: true },
    );

    return {
      id: id.toString(),
      customer_name: input.customerName,
      customer_contact: input.customerContact,
      status: 'open',
      created_at: now,
      updated_at: now,
    };
  }

  async assignToOperator(
    id: string,
    operatorId: string,
    operatorName: string,
  ): Promise<Task | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();

    const query = `
      UPDATE tasks
      SET operator_id = ?, operator_name = ?, status = ?, assigned_at = ?, updated_at = ?
      WHERE id = ?
    `;

    await this.client.execute(
      query,
      [
        operatorId,
        operatorName,
        'assigned' satisfies TaskStatus,
        existing.assigned_at ?? now,
        now,
        types.Uuid.fromString(id),
      ],
      { prepare: true },
    );

    return this.findById(id);
  }

  async setGreetingSent(id: string, greetingSentAt: Date): Promise<Task | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();

    const query = `
      UPDATE tasks
      SET greeting_sent_at = ?, ping_sent_at = ?, inactive_sent_at = ?, updated_at = ?
      WHERE id = ?
    `;

    await this.client.execute(query, [greetingSentAt, null, null, now, types.Uuid.fromString(id)], {
      prepare: true,
    });

    return this.findById(id);
  }

  async markCustomerActivity(id: string, at: Date): Promise<Task | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();

    const query = `
      UPDATE tasks
      SET last_customer_activity_at = ?, updated_at = ?
      WHERE id = ?
    `;

    await this.client.execute(query, [at, now, types.Uuid.fromString(id)], {
      prepare: true,
    });

    return this.findById(id);
  }

  async markPingSent(id: string, at: Date): Promise<Task | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();

    const query = `
      UPDATE tasks
      SET ping_sent_at = ?, updated_at = ?
      WHERE id = ?
    `;

    await this.client.execute(query, [at, now, types.Uuid.fromString(id)], {
      prepare: true,
    });

    return this.findById(id);
  }

  async closeDueToInactivity(id: string, at: Date): Promise<Task | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();

    const query = `
      UPDATE tasks
      SET inactive_sent_at = ?, status = ?, closed_at = ?, close_reason = ?, updated_at = ?
      WHERE id = ?
    `;

    await this.client.execute(
      query,
      [at, 'closed' satisfies TaskStatus, at, 'inactivity', now, types.Uuid.fromString(id)],
      { prepare: true },
    );

    return this.findById(id);
  }

  private mapRowToTask(row: types.Row): Task {
    const assignedAt = row.get('assigned_at') as Date | null;
    const greetingSentAt = row.get('greeting_sent_at') as Date | null;
    const pingSentAt = row.get('ping_sent_at') as Date | null;
    const inactiveSentAt = row.get('inactive_sent_at') as Date | null;
    const lastCustomerActivityAt = row.get('last_customer_activity_at') as Date | null;
    const closedAt = row.get('closed_at') as Date | null;

    return {
      id: row.get('id')?.toString() ?? '',
      customer_name: row.get('customer_name') ?? '',
      customer_contact: row.get('customer_contact') ?? '',
      operator_id: row.get('operator_id') ?? undefined,
      operator_name: row.get('operator_name') ?? undefined,
      status: (row.get('status') as TaskStatus) ?? 'open',
      created_at: row.get('created_at') ?? new Date(),
      updated_at: row.get('updated_at') ?? new Date(),
      assigned_at: assignedAt ?? undefined,
      greeting_sent_at: greetingSentAt ?? undefined,
      ping_sent_at: pingSentAt ?? undefined,
      inactive_sent_at: inactiveSentAt ?? undefined,
      last_customer_activity_at: lastCustomerActivityAt ?? undefined,
      closed_at: closedAt ?? undefined,
      close_reason: row.get('close_reason') ?? undefined,
    };
  }
}

export const tasksRepository = new TasksRepository();
