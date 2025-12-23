import type { types } from 'cassandra-driver';
import { getClient } from '@/database';

export interface FlexTaskState {
  task_sid: string;
  conversation_sid?: string;
  channel_type?: string;
  customer_name?: string;
  customer_address?: string;
  customer_from?: string;
  worker_sid?: string;
  worker_name?: string;
  task_assignment_status?: string;
  task_attributes?: string;
  greeting_sent_at?: Date;
  ping_sent_at?: Date;
  inactive_sent_at?: Date;
  last_customer_activity_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export class FlexTasksRepository {
  private get client() {
    return getClient();
  }

  async findByTaskSid(taskSid: string): Promise<FlexTaskState | null> {
    const query = 'SELECT * FROM flex_tasks WHERE task_sid = ?';
    const result = await this.client.execute(query, [taskSid], {
      prepare: true,
    });
    const row = result.rows[0];
    return row ? this.mapRow(row) : null;
  }

  async findByConversationSid(conversationSid: string): Promise<FlexTaskState | null> {
    const lookupQuery =
      'SELECT task_sid FROM flex_tasks_by_conversation WHERE conversation_sid = ?';
    const lookupResult = await this.client.execute(lookupQuery, [conversationSid], {
      prepare: true,
    });
    const lookupRow = lookupResult.rows[0];
    if (!lookupRow) return null;

    const taskSid = lookupRow.get('task_sid') as string | null;
    if (!taskSid) return null;
    return this.findByTaskSid(taskSid);
  }

  async upsertBaseState(input: {
    taskSid: string;
    conversationSid?: string;
    channelType?: string;
    customerName?: string;
    customerAddress?: string;
    customerFrom?: string;
    workerSid?: string;
    workerName?: string;
    assignmentStatus?: string;
    taskAttributes?: string;
  }): Promise<void> {
    const now = new Date();

    const existing = await this.findByTaskSid(input.taskSid);
    const createdAt = existing?.created_at ?? now;

    const query = `
      INSERT INTO flex_tasks (
        task_sid,
        conversation_sid,
        channel_type,
        customer_name,
        customer_address,
        customer_from,
        worker_sid,
        worker_name,
        task_assignment_status,
        task_attributes,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.client.execute(
      query,
      [
        input.taskSid,
        input.conversationSid ?? null,
        input.channelType ?? null,
        input.customerName ?? null,
        input.customerAddress ?? null,
        input.customerFrom ?? null,
        input.workerSid ?? null,
        input.workerName ?? null,
        input.assignmentStatus ?? null,
        input.taskAttributes ?? null,
        createdAt,
        now,
      ],
      { prepare: true },
    );

    if (input.conversationSid) {
      await this.client.execute(
        'INSERT INTO flex_tasks_by_conversation (conversation_sid, task_sid) VALUES (?, ?)',
        [input.conversationSid, input.taskSid],
        { prepare: true },
      );
    }
  }

  async setGreetingSent(taskSid: string, at: Date): Promise<void> {
    const now = new Date();
    const query = `
      UPDATE flex_tasks
      SET greeting_sent_at = ?, ping_sent_at = ?, inactive_sent_at = ?, updated_at = ?
      WHERE task_sid = ?
    `;
    await this.client.execute(query, [at, null, null, now, taskSid], {
      prepare: true,
    });
  }

  async markPingSent(taskSid: string, at: Date): Promise<void> {
    const now = new Date();
    const query = `
      UPDATE flex_tasks
      SET ping_sent_at = ?, updated_at = ?
      WHERE task_sid = ?
    `;
    await this.client.execute(query, [at, now, taskSid], { prepare: true });
  }

  async markInactiveSent(taskSid: string, at: Date): Promise<void> {
    const now = new Date();
    const query = `
      UPDATE flex_tasks
      SET inactive_sent_at = ?, updated_at = ?
      WHERE task_sid = ?
    `;
    await this.client.execute(query, [at, now, taskSid], { prepare: true });
  }

  async markCustomerActivity(taskSid: string, at: Date): Promise<void> {
    const now = new Date();
    const query = `
      UPDATE flex_tasks
      SET last_customer_activity_at = ?, updated_at = ?
      WHERE task_sid = ?
    `;
    await this.client.execute(query, [at, now, taskSid], { prepare: true });
  }

  private mapRow(row: types.Row): FlexTaskState {
    const greetingSentAt = row.get('greeting_sent_at') as Date | null;
    const pingSentAt = row.get('ping_sent_at') as Date | null;
    const inactiveSentAt = row.get('inactive_sent_at') as Date | null;
    const lastCustomerActivityAt = row.get('last_customer_activity_at') as Date | null;

    return {
      task_sid: (row.get('task_sid') as string) ?? '',
      conversation_sid: row.get('conversation_sid') ?? undefined,
      channel_type: row.get('channel_type') ?? undefined,
      customer_name: row.get('customer_name') ?? undefined,
      customer_address: row.get('customer_address') ?? undefined,
      customer_from: row.get('customer_from') ?? undefined,
      worker_sid: row.get('worker_sid') ?? undefined,
      worker_name: row.get('worker_name') ?? undefined,
      task_assignment_status: row.get('task_assignment_status') ?? undefined,
      task_attributes: row.get('task_attributes') ?? undefined,
      greeting_sent_at: greetingSentAt ?? undefined,
      ping_sent_at: pingSentAt ?? undefined,
      inactive_sent_at: inactiveSentAt ?? undefined,
      last_customer_activity_at: lastCustomerActivityAt ?? undefined,
      created_at: row.get('created_at') ?? new Date(),
      updated_at: row.get('updated_at') ?? new Date(),
    };
  }
}

export const flexTasksRepository = new FlexTasksRepository();
