import { Client } from 'cassandra-driver';
import { env } from '@/config/env';

export async function runMigrations(): Promise<void> {
  const adminClient = new Client({
    contactPoints: env.scylla.contactPoints,
    localDataCenter: env.scylla.localDataCenter,
  });

  try {
    await adminClient.connect();

    await adminClient.execute(`
      CREATE KEYSPACE IF NOT EXISTS ${env.scylla.keyspace}
      WITH replication = {
        'class': 'NetworkTopologyStrategy',
        '${env.scylla.localDataCenter}': 1
      }
      AND tablets = {'enabled': false}
    `);

    // Tabela principal de users - query por ID
    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.users (
        id uuid PRIMARY KEY,
        email text,
        name text,
        password_hash text,
        created_at timestamp,
        updated_at timestamp
      )
    `);

    // Tabela de lookup para buscar user por email (denormalização)
    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.users_by_email (
        email text PRIMARY KEY,
        user_id uuid
      )
    `);

    // Sessions com partition key = token (query direta)
    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.sessions (
        session_token text PRIMARY KEY,
        user_id uuid,
        user_agent text,
        ip_address text,
        created_at timestamp,
        expires_at timestamp
      )
    `);

    // Sessions por user (para listar todas as sessões de um usuário)
    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.sessions_by_user (
        user_id uuid,
        session_token text,
        user_agent text,
        ip_address text,
        created_at timestamp,
        expires_at timestamp,
        PRIMARY KEY (user_id, created_at, session_token)
      ) WITH CLUSTERING ORDER BY (created_at DESC, session_token ASC)
    `);

    // ============================================
    // Flows - Sistema de chatbot simplificado
    // ============================================

    // Tabela principal de flows - query por ID
    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.flows (
        id uuid PRIMARY KEY,
        name text,
        description text,
        nodes text,
        start_node_id text,
        twilio_flow_sid text,
        status text,
        error_message text,
        created_at timestamp,
        updated_at timestamp,
        published_at timestamp
      )
    `);

    // Lookup por twilio_flow_sid (para identificar flow por webhook)
    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.flows_by_twilio_sid (
        twilio_flow_sid text PRIMARY KEY,
        flow_id uuid
      )
    `);

    // ============================================
    // Tasks - atendimento humano (operadores)
    // ============================================

    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.tasks (
        id uuid PRIMARY KEY,
        customer_name text,
        customer_contact text,
        operator_id text,
        operator_name text,
        status text,
        created_at timestamp,
        updated_at timestamp,
        assigned_at timestamp,
        greeting_sent_at timestamp,
        ping_sent_at timestamp,
        inactive_sent_at timestamp,
        last_customer_activity_at timestamp,
        closed_at timestamp,
        close_reason text
      )
    `);

    // Estado de automação para tasks do Twilio Flex/TaskRouter
    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.flex_tasks (
        task_sid text PRIMARY KEY,
        conversation_sid text,
        channel_type text,
        customer_name text,
        customer_address text,
        customer_from text,
        worker_sid text,
        worker_name text,
        task_assignment_status text,
        task_attributes text,
        greeting_sent_at timestamp,
        ping_sent_at timestamp,
        inactive_sent_at timestamp,
        last_customer_activity_at timestamp,
        created_at timestamp,
        updated_at timestamp
      )
    `);

    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.flex_tasks_by_conversation (
        conversation_sid text PRIMARY KEY,
        task_sid text
      )
    `);

    // ============================================
    // Twilio Cache (Workflows / TaskChannels / Content Templates)
    // ============================================

    await adminClient.execute(`
      CREATE TABLE IF NOT EXISTS ${env.scylla.keyspace}.twilio_cache (
        cache_key text PRIMARY KEY,
        value text,
        updated_at timestamp
      )
    `);
  } finally {
    await adminClient.shutdown();
  }
}
