import type { types } from 'cassandra-driver';
import { getClient } from '@/database';

export type TwilioCacheEntry = {
  key: string;
  value: string;
  updatedAt: Date;
};

export class TwilioCacheRepository {
  private get client() {
    return getClient();
  }

  async get(key: string): Promise<TwilioCacheEntry | null> {
    const query = 'SELECT cache_key, value, updated_at FROM twilio_cache WHERE cache_key = ?';

    const result = await this.client.execute(query, [key], { prepare: true });
    const row = result.rows[0] as types.Row | undefined;
    if (!row) return null;

    return {
      key: row.get('cache_key') ?? '',
      value: row.get('value') ?? '',
      updatedAt: row.get('updated_at') ?? new Date(0),
    };
  }

  async set(key: string, value: string): Promise<void> {
    const query = 'INSERT INTO twilio_cache (cache_key, value, updated_at) VALUES (?, ?, ?)';
    await this.client.execute(query, [key, value, new Date()], {
      prepare: true,
    });
  }

  async delete(key: string): Promise<void> {
    const query = 'DELETE FROM twilio_cache WHERE cache_key = ?';
    await this.client.execute(query, [key], { prepare: true });
  }
}

export const twilioCacheRepository = new TwilioCacheRepository();
