import { types } from 'cassandra-driver';
import { getClient } from '@/database';
import type { Flow, FlowInput, FlowNode, FlowStatus, FlowUpdateInput } from './flows.types';

export class FlowsRepository {
  private get client() {
    return getClient();
  }

  async findAll(limit = 100): Promise<Flow[]> {
    const asInt = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const safeLimit = Math.min(Math.max(asInt, 1), 1000);
    const query = `SELECT * FROM flows LIMIT ${safeLimit}`;
    const result = await this.client.execute(query);
    return result.rows.map((row) => this.mapRowToFlow(row));
  }

  async findById(id: string): Promise<Flow | null> {
    const query = 'SELECT * FROM flows WHERE id = ?';
    const result = await this.client.execute(query, [types.Uuid.fromString(id)], { prepare: true });
    const row = result.rows[0];
    return row ? this.mapRowToFlow(row) : null;
  }

  async findByTwilioSid(twilioFlowSid: string): Promise<Flow | null> {
    const lookupQuery = 'SELECT flow_id FROM flows_by_twilio_sid WHERE twilio_flow_sid = ?';
    const lookupResult = await this.client.execute(lookupQuery, [twilioFlowSid], { prepare: true });
    const lookupRow = lookupResult.rows[0];

    if (!lookupRow) return null;

    const flowId = lookupRow.get('flow_id');
    return this.findById(flowId.toString());
  }

  async create(input: FlowInput): Promise<Flow> {
    const id = types.Uuid.random();
    const now = new Date();

    const query = `
      INSERT INTO flows (id, name, description, nodes, start_node_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.client.execute(
      query,
      [
        id,
        input.name,
        input.description || null,
        JSON.stringify(input.nodes),
        input.startNodeId,
        'draft' as FlowStatus,
        now,
        now,
      ],
      { prepare: true },
    );

    return {
      id: id.toString(),
      name: input.name,
      description: input.description,
      nodes: input.nodes,
      start_node_id: input.startNodeId,
      status: 'draft',
      created_at: now,
      updated_at: now,
    };
  }

  async update(id: string, input: FlowUpdateInput): Promise<Flow | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();
    const updates: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (input.name !== undefined) {
      updates.push('name = ?');
      values.push(input.name);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }

    if (input.nodes !== undefined) {
      updates.push('nodes = ?');
      values.push(JSON.stringify(input.nodes));
    }

    if (input.startNodeId !== undefined) {
      updates.push('start_node_id = ?');
      values.push(input.startNodeId);
    }

    values.push(types.Uuid.fromString(id));

    const query = `UPDATE flows SET ${updates.join(', ')} WHERE id = ?`;
    await this.client.execute(query, values, { prepare: true });

    return this.findById(id);
  }

  async updateStatus(
    id: string,
    status: FlowStatus,
    twilioFlowSid?: string,
    errorMessage?: string,
  ): Promise<Flow | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();
    const updates: string[] = ['updated_at = ?', 'status = ?'];
    const values: unknown[] = [now, status];

    if (twilioFlowSid !== undefined) {
      updates.push('twilio_flow_sid = ?');
      values.push(twilioFlowSid);

      // Atualizar lookup table
      if (existing.twilio_flow_sid && existing.twilio_flow_sid !== twilioFlowSid) {
        await this.client.execute('DELETE FROM flows_by_twilio_sid WHERE twilio_flow_sid = ?', [
          existing.twilio_flow_sid,
        ]);
      }

      if (twilioFlowSid) {
        await this.client.execute(
          'INSERT INTO flows_by_twilio_sid (twilio_flow_sid, flow_id) VALUES (?, ?)',
          [twilioFlowSid, types.Uuid.fromString(id)],
          { prepare: true },
        );
      }
    }

    if (errorMessage !== undefined) {
      updates.push('error_message = ?');
      values.push(errorMessage);
    }

    if (status === 'published') {
      updates.push('published_at = ?');
      values.push(now);
    }

    values.push(types.Uuid.fromString(id));

    const query = `UPDATE flows SET ${updates.join(', ')} WHERE id = ?`;
    await this.client.execute(query, values, { prepare: true });

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) return false;

    // Remover da lookup table se existir
    if (existing.twilio_flow_sid) {
      await this.client.execute('DELETE FROM flows_by_twilio_sid WHERE twilio_flow_sid = ?', [
        existing.twilio_flow_sid,
      ]);
    }

    // Deletar o flow
    const deleteQuery = 'DELETE FROM flows WHERE id = ?';
    await this.client.execute(deleteQuery, [types.Uuid.fromString(id)], {
      prepare: true,
    });

    return true;
  }

  private mapRowToFlow(row: types.Row): Flow {
    const nodesJson = row.get('nodes');
    let nodes: FlowNode[] = [];

    try {
      nodes = nodesJson ? JSON.parse(nodesJson) : [];
    } catch {
      nodes = [];
    }

    return {
      id: row.get('id')?.toString() ?? '',
      name: row.get('name') ?? '',
      description: row.get('description') ?? undefined,
      nodes,
      start_node_id: row.get('start_node_id') ?? '',
      twilio_flow_sid: row.get('twilio_flow_sid') ?? undefined,
      status: (row.get('status') as FlowStatus) ?? 'draft',
      error_message: row.get('error_message') ?? undefined,
      created_at: row.get('created_at') ?? new Date(),
      updated_at: row.get('updated_at') ?? new Date(),
      published_at: row.get('published_at') ?? undefined,
    };
  }
}

export const flowsRepository = new FlowsRepository();
