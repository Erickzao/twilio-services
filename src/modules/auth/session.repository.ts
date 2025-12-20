import { types } from 'cassandra-driver';
import { getClient } from '@/database';
import type { Session } from '@/shared/types';

export class SessionRepository {
  private get client() {
    return getClient();
  }

  async create(
    userId: string,
    expiresInMs: number,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<Session> {
    const token = this.generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInMs);
    const ttlSeconds = Math.floor(expiresInMs / 1000);
    const userIdUuid = types.Uuid.fromString(userId);

    // Insert na tabela principal (por token)
    const sessionsQuery = `
      INSERT INTO sessions (session_token, user_id, user_agent, ip_address, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      USING TTL ?
    `;
    await this.client.execute(
      sessionsQuery,
      [token, userIdUuid, userAgent, ipAddress, now, expiresAt, ttlSeconds],
      { prepare: true },
    );

    // Insert na tabela por user (para listar sessões)
    const sessionsByUserQuery = `
      INSERT INTO sessions_by_user (user_id, session_token, user_agent, ip_address, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      USING TTL ?
    `;
    await this.client.execute(
      sessionsByUserQuery,
      [userIdUuid, token, userAgent, ipAddress, now, expiresAt, ttlSeconds],
      { prepare: true },
    );

    return {
      token,
      user_id: userId,
      user_agent: userAgent,
      ip_address: ipAddress,
      created_at: now,
      expires_at: expiresAt,
    };
  }

  async findByToken(token: string): Promise<Session | null> {
    const query = 'SELECT * FROM sessions WHERE session_token = ?';
    const result = await this.client.execute(query, [token], { prepare: true });
    const row = result.rows[0];

    if (!row) return null;

    const session = this.mapRowToSession(row);

    if (session.expires_at < new Date()) {
      await this.delete(token, session.user_id);
      return null;
    }

    return session;
  }

  async findByUserId(userId: string): Promise<Session[]> {
    const query = 'SELECT * FROM sessions_by_user WHERE user_id = ?';
    const result = await this.client.execute(query, [types.Uuid.fromString(userId)], {
      prepare: true,
    });

    return result.rows
      .map(this.mapRowToSession)
      .filter((session) => session.expires_at > new Date());
  }

  async delete(token: string, userId?: string): Promise<void> {
    // Delete da tabela principal
    const deleteSessionQuery = 'DELETE FROM sessions WHERE session_token = ?';
    await this.client.execute(deleteSessionQuery, [token], { prepare: true });

    // Delete da tabela por user (precisa do user_id e created_at)
    if (userId) {
      const session = await this.findSessionInByUser(userId, token);
      if (session) {
        const deleteByUserQuery =
          'DELETE FROM sessions_by_user WHERE user_id = ? AND created_at = ? AND session_token = ?';
        await this.client.execute(
          deleteByUserQuery,
          [types.Uuid.fromString(userId), session.created_at, token],
          { prepare: true },
        );
      }
    }
  }

  async deleteAllForUser(userId: string): Promise<void> {
    const sessions = await this.findByUserId(userId);

    // Delete de todas as sessões na tabela principal
    for (const session of sessions) {
      const deleteSessionQuery = 'DELETE FROM sessions WHERE session_token = ?';
      await this.client.execute(deleteSessionQuery, [session.token], { prepare: true });
    }

    // Delete todas de sessions_by_user
    const deleteByUserQuery = 'DELETE FROM sessions_by_user WHERE user_id = ?';
    await this.client.execute(deleteByUserQuery, [types.Uuid.fromString(userId)], {
      prepare: true,
    });
  }

  private async findSessionInByUser(userId: string, token: string): Promise<Session | null> {
    const query =
      'SELECT * FROM sessions_by_user WHERE user_id = ? AND session_token = ? ALLOW FILTERING';
    const result = await this.client.execute(query, [types.Uuid.fromString(userId), token], {
      prepare: true,
    });
    const row = result.rows[0];
    return row ? this.mapRowToSession(row) : null;
  }

  private generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private mapRowToSession(row: types.Row): Session {
    return {
      token: row.get('session_token') ?? '',
      user_id: row.get('user_id')?.toString() ?? '',
      user_agent: row.get('user_agent') ?? undefined,
      ip_address: row.get('ip_address') ?? undefined,
      created_at: row.get('created_at') ?? new Date(),
      expires_at: row.get('expires_at') ?? new Date(),
    };
  }
}

export const sessionRepository = new SessionRepository();
