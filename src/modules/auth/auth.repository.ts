import { types } from 'cassandra-driver';
import { getClient } from '@/database';
import type { SignUpInput, User } from '@/shared/types';

export class AuthRepository {
  private get client() {
    return getClient();
  }

  async findByEmail(email: string): Promise<User | null> {
    // Primeiro busca o user_id na tabela de lookup
    const lookupQuery = 'SELECT user_id FROM users_by_email WHERE email = ?';
    const lookupResult = await this.client.execute(lookupQuery, [email], { prepare: true });
    const lookupRow = lookupResult.rows[0];

    if (!lookupRow) return null;

    // Depois busca o user completo
    const userId = lookupRow.get('user_id');
    return this.findById(userId.toString());
  }

  async findById(id: string): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE id = ?';
    const result = await this.client.execute(query, [types.Uuid.fromString(id)], { prepare: true });
    const row = result.rows[0];
    return row ? this.mapRowToUser(row) : null;
  }

  async create(input: SignUpInput, passwordHash: string): Promise<User> {
    const id = types.Uuid.random();
    const now = new Date();

    // Insert na tabela principal
    const userQuery = `
      INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    await this.client.execute(userQuery, [id, input.email, input.name, passwordHash, now, now], {
      prepare: true,
    });

    // Insert na tabela de lookup
    const lookupQuery = `
      INSERT INTO users_by_email (email, user_id)
      VALUES (?, ?)
    `;
    await this.client.execute(lookupQuery, [input.email, id], { prepare: true });

    return {
      id: id.toString(),
      email: input.email,
      name: input.name,
      password_hash: passwordHash,
      created_at: now,
      updated_at: now,
    };
  }

  private mapRowToUser(row: types.Row): User {
    return {
      id: row.get('id')?.toString() ?? '',
      email: row.get('email') ?? '',
      name: row.get('name') ?? '',
      password_hash: row.get('password_hash') ?? undefined,
      created_at: row.get('created_at') ?? new Date(),
      updated_at: row.get('updated_at') ?? new Date(),
    };
  }
}

export const authRepository = new AuthRepository();
