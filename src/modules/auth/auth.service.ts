import { env } from '@/config/env';
import type { Session, SignInInput, SignUpInput, User } from '@/shared/types';
import { authRepository } from './auth.repository';
import { sessionRepository } from './session.repository';

interface AuthResult {
  user: Omit<User, 'password_hash'>;
  session: Session;
}

export class AuthService {
  async signUp(input: SignUpInput, userAgent?: string, ipAddress?: string): Promise<AuthResult> {
    const existingUser = await authRepository.findByEmail(input.email);
    if (existingUser) {
      throw new Error('Email already registered');
    }

    const passwordHash = await Bun.password.hash(input.password, {
      algorithm: 'argon2id',
      memoryCost: 4096,
      timeCost: 1,
    });

    const user = await authRepository.create(input, passwordHash);
    const session = await sessionRepository.create(
      user.id,
      env.session.expiresInMs,
      userAgent,
      ipAddress,
    );

    const { password_hash: _, ...userWithoutPassword } = user;
    return { user: userWithoutPassword, session };
  }

  async signIn(input: SignInInput, userAgent?: string, ipAddress?: string): Promise<AuthResult> {
    const user = await authRepository.findByEmail(input.email);
    if (!user || !user.password_hash) {
      throw new Error('Invalid email or password');
    }

    const isValidPassword = await Bun.password.verify(input.password, user.password_hash);

    if (!isValidPassword) {
      throw new Error('Invalid email or password');
    }

    const session = await sessionRepository.create(
      user.id,
      env.session.expiresInMs,
      userAgent,
      ipAddress,
    );

    const { password_hash: _, ...userWithoutPassword } = user;
    return { user: userWithoutPassword, session };
  }

  async signOut(token: string): Promise<void> {
    await sessionRepository.delete(token);
  }

  async signOutAll(userId: string): Promise<void> {
    await sessionRepository.deleteAllForUser(userId);
  }

  async validateSession(token: string): Promise<Omit<User, 'password_hash'> | null> {
    const session = await sessionRepository.findByToken(token);
    if (!session) return null;

    const user = await authRepository.findById(session.user_id);
    if (!user) return null;

    const { password_hash: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  async getUserSessions(userId: string): Promise<Session[]> {
    return sessionRepository.findByUserId(userId);
  }
}

export const authService = new AuthService();
