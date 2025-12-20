import { Client } from 'cassandra-driver';
import { env } from '@/config/env';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('ScyllaDB');

let client: Client | null = null;

export function getClient(): Client {
  if (!client) {
    throw new Error('Database client not initialized. Call connectDatabase() first.');
  }
  return client;
}

export async function connectDatabase(): Promise<Client> {
  if (client) {
    return client;
  }

  client = new Client({
    contactPoints: env.scylla.contactPoints,
    localDataCenter: env.scylla.localDataCenter,
    keyspace: env.scylla.keyspace,
  });

  await client.connect();
  logger.log(`Connected to keyspace "${env.scylla.keyspace}"`);

  return client;
}

export async function disconnectDatabase(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
    logger.log('Connection closed');
  }
}

export async function executeQuery<T = unknown>(query: string, params?: unknown[]): Promise<T[]> {
  const db = getClient();
  const result = await db.execute(query, params, { prepare: true });
  return result.rows as T[];
}
