import { types } from "cassandra-driver";
import { getClient } from "@/database";
import type { CreateUserInput, UpdateUserInput, User } from "@/shared/types";

export class UsersRepository {
  private get client() {
    return getClient();
  }

  async findAll(limit = 100): Promise<User[]> {
    const asInt = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const safeLimit = Math.min(Math.max(asInt, 1), 1000);
    const query = `SELECT * FROM users LIMIT ${safeLimit}`;
    const result = await this.client.execute(query);
    return result.rows.map(this.mapRowToUser);
  }

  async findById(id: string): Promise<User | null> {
    const query = "SELECT * FROM users WHERE id = ?";
    const result = await this.client.execute(
      query,
      [types.Uuid.fromString(id)],
      { prepare: true },
    );
    const row = result.rows[0];
    return row ? this.mapRowToUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    // Busca na tabela de lookup
    const lookupQuery = "SELECT user_id FROM users_by_email WHERE email = ?";
    const lookupResult = await this.client.execute(lookupQuery, [email], {
      prepare: true,
    });
    const lookupRow = lookupResult.rows[0];

    if (!lookupRow) return null;

    const userId = lookupRow.get("user_id");
    return this.findById(userId.toString());
  }

  async create(input: CreateUserInput): Promise<User> {
    const id = types.Uuid.random();
    const now = new Date();

    // Insert na tabela principal
    const userQuery = `
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `;
    await this.client.execute(
      userQuery,
      [id, input.email, input.name, now, now],
      {
        prepare: true,
      },
    );

    // Insert na tabela de lookup
    const lookupQuery = `
      INSERT INTO users_by_email (email, user_id)
      VALUES (?, ?)
    `;
    await this.client.execute(lookupQuery, [input.email, id], {
      prepare: true,
    });

    return {
      id: id.toString(),
      email: input.email,
      name: input.name,
      created_at: now,
      updated_at: now,
    };
  }

  async update(id: string, input: UpdateUserInput): Promise<User | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();
    const updates: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (input.name !== undefined) {
      updates.push("name = ?");
      values.push(input.name);
    }

    // Se está atualizando email, precisa atualizar lookup
    if (input.email !== undefined && input.email !== existing.email) {
      updates.push("email = ?");
      values.push(input.email);

      // Remove lookup antigo
      const deleteLookupQuery = "DELETE FROM users_by_email WHERE email = ?";
      await this.client.execute(deleteLookupQuery, [existing.email], {
        prepare: true,
      });

      // Cria novo lookup
      const insertLookupQuery =
        "INSERT INTO users_by_email (email, user_id) VALUES (?, ?)";
      await this.client.execute(
        insertLookupQuery,
        [input.email, types.Uuid.fromString(id)],
        {
          prepare: true,
        },
      );
    }

    values.push(types.Uuid.fromString(id));

    const query = `UPDATE users SET ${updates.join(", ")} WHERE id = ?`;
    await this.client.execute(query, values, { prepare: true });

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) return false;

    // Delete do lookup
    const deleteLookupQuery = "DELETE FROM users_by_email WHERE email = ?";
    await this.client.execute(deleteLookupQuery, [existing.email], {
      prepare: true,
    });

    // Delete do user
    const deleteUserQuery = "DELETE FROM users WHERE id = ?";
    await this.client.execute(deleteUserQuery, [types.Uuid.fromString(id)], {
      prepare: true,
    });

    return true;
  }

  private mapRowToUser(row: types.Row): User {
    return {
      id: row.get("id")?.toString() ?? "",
      email: row.get("email") ?? "",
      name: row.get("name") ?? "",
      created_at: row.get("created_at") ?? new Date(),
      updated_at: row.get("updated_at") ?? new Date(),
    };
  }
}

export const usersRepository = new UsersRepository();
