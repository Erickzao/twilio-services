import { Elysia, t } from 'elysia';
import { env } from '@/config/env';
import { authService } from './auth.service';

const COOKIE_NAME = env.session.cookieName;
const COOKIE_MAX_AGE = Math.floor(env.session.expiresInMs / 1000);

export const authController = new Elysia({ prefix: '/auth' })
  .post(
    '/signup',
    async ({ body, headers, set, request, cookie }) => {
      try {
        const userAgent = headers['user-agent'];
        const ipAddress = request.headers.get('x-forwarded-for') || 'unknown';

        const { user, session } = await authService.signUp(body, userAgent, ipAddress);

        cookie[COOKIE_NAME]?.set({
          value: session.token,
          httpOnly: true,
          secure: env.isProd,
          sameSite: 'strict',
          maxAge: COOKIE_MAX_AGE,
          path: '/',
        });

        set.status = 201;
        return { data: { user } };
      } catch (err) {
        set.status = 400;
        const message = err instanceof Error ? err.message : 'Failed to sign up';
        return { message };
      }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
        name: t.String({ minLength: 1 }),
        password: t.String({ minLength: 6 }),
      }),
      detail: {
        summary: 'Register a new user',
        tags: ['Auth'],
      },
    },
  )
  .post(
    '/signin',
    async ({ body, headers, set, request, cookie }) => {
      try {
        const userAgent = headers['user-agent'];
        const ipAddress = request.headers.get('x-forwarded-for') || 'unknown';

        const { user, session } = await authService.signIn(body, userAgent, ipAddress);

        cookie[COOKIE_NAME]?.set({
          value: session.token,
          httpOnly: true,
          secure: env.isProd,
          sameSite: 'strict',
          maxAge: COOKIE_MAX_AGE,
          path: '/',
        });

        return { data: { user } };
      } catch (err) {
        set.status = 401;
        const message = err instanceof Error ? err.message : 'Failed to sign in';
        return { message };
      }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
        password: t.String({ minLength: 1 }),
      }),
      detail: {
        summary: 'Sign in with email and password',
        tags: ['Auth'],
      },
    },
  )
  .post(
    '/signout',
    async ({ cookie, set }) => {
      const token = cookie[COOKIE_NAME]?.value;
      if (!token || typeof token !== 'string') {
        set.status = 401;
        return { message: 'Not authenticated' };
      }

      await authService.signOut(token);

      cookie[COOKIE_NAME]?.set({
        value: '',
        httpOnly: true,
        secure: env.isProd,
        sameSite: 'strict',
        maxAge: 0,
        path: '/',
      });

      return { message: 'Signed out successfully' };
    },
    {
      detail: {
        summary: 'Sign out current session',
        tags: ['Auth'],
      },
    },
  )
  .get(
    '/me',
    async ({ cookie, set }) => {
      const token = cookie[COOKIE_NAME]?.value;
      if (!token || typeof token !== 'string') {
        set.status = 401;
        return { message: 'Not authenticated' };
      }

      const user = await authService.validateSession(token);
      if (!user) {
        set.status = 401;
        return { message: 'Invalid or expired session' };
      }

      return { data: user };
    },
    {
      detail: {
        summary: 'Get current authenticated user',
        tags: ['Auth'],
      },
    },
  )
  .get(
    '/sessions',
    async ({ cookie, set }) => {
      const token = cookie[COOKIE_NAME]?.value;
      if (!token || typeof token !== 'string') {
        set.status = 401;
        return { message: 'Not authenticated' };
      }

      const user = await authService.validateSession(token);
      if (!user) {
        set.status = 401;
        return { message: 'Invalid or expired session' };
      }

      const sessions = await authService.getUserSessions(user.id);

      return {
        data: sessions.map((s) => ({
          id: `${s.token.slice(0, 8)}...`,
          user_agent: s.user_agent,
          ip_address: s.ip_address,
          created_at: s.created_at,
          expires_at: s.expires_at,
          is_current: s.token === token,
        })),
      };
    },
    {
      detail: {
        summary: 'List all active sessions',
        tags: ['Auth'],
      },
    },
  )
  .post(
    '/signout-all',
    async ({ cookie, set }) => {
      const token = cookie[COOKIE_NAME]?.value;
      if (!token || typeof token !== 'string') {
        set.status = 401;
        return { message: 'Not authenticated' };
      }

      const user = await authService.validateSession(token);
      if (!user) {
        set.status = 401;
        return { message: 'Invalid or expired session' };
      }

      await authService.signOutAll(user.id);

      cookie[COOKIE_NAME]?.set({
        value: '',
        httpOnly: true,
        secure: env.isProd,
        sameSite: 'strict',
        maxAge: 0,
        path: '/',
      });

      return { message: 'All sessions terminated' };
    },
    {
      detail: {
        summary: 'Sign out from all devices',
        tags: ['Auth'],
      },
    },
  );
