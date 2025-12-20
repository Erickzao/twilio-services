import { Elysia, t } from 'elysia';
import { usersService } from './users.service';

export const usersController = new Elysia({ prefix: '/users' })
  .get(
    '/',
    async ({ query }) => {
      const users = await usersService.getAll(query.limit);
      return { data: users };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ default: 100 })),
      }),
      detail: {
        summary: 'List all users',
        tags: ['Users'],
      },
    },
  )
  .get(
    '/:id',
    async ({ params, set }) => {
      const user = await usersService.getById(params.id);
      if (!user) {
        set.status = 404;
        return { message: 'User not found' };
      }
      return { data: user };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: 'Get user by ID',
        tags: ['Users'],
      },
    },
  )
  .post(
    '/',
    async ({ body, set }) => {
      try {
        const user = await usersService.create(body);
        return { data: user };
      } catch (err) {
        set.status = 400;
        const message = err instanceof Error ? err.message : 'Failed to create user';
        return { message };
      }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
        name: t.String({ minLength: 1 }),
      }),
      detail: {
        summary: 'Create a new user',
        tags: ['Users'],
      },
    },
  )
  .put(
    '/:id',
    async ({ params, body, set }) => {
      try {
        const user = await usersService.update(params.id, body);
        if (!user) {
          set.status = 404;
          return { message: 'User not found' };
        }
        return { data: user };
      } catch (err) {
        set.status = 400;
        const message = err instanceof Error ? err.message : 'Failed to update user';
        return { message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        email: t.Optional(t.String({ format: 'email' })),
        name: t.Optional(t.String({ minLength: 1 })),
      }),
      detail: {
        summary: 'Update user by ID',
        tags: ['Users'],
      },
    },
  )
  .delete(
    '/:id',
    async ({ params, set }) => {
      const deleted = await usersService.delete(params.id);
      if (!deleted) {
        set.status = 404;
        return { message: 'User not found' };
      }
      return { message: 'User deleted successfully' };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: 'Delete user by ID',
        tags: ['Users'],
      },
    },
  );
