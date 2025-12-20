import type { CreateUserInput, UpdateUserInput, User } from '@/shared/types';
import { usersRepository } from './users.repository';

export class UsersService {
  async getAll(limit?: number): Promise<User[]> {
    return usersRepository.findAll(limit);
  }

  async getById(id: string): Promise<User | null> {
    return usersRepository.findById(id);
  }

  async getByEmail(email: string): Promise<User | null> {
    return usersRepository.findByEmail(email);
  }

  async create(input: CreateUserInput): Promise<User> {
    const existingUser = await usersRepository.findByEmail(input.email);
    if (existingUser) {
      throw new Error('User with this email already exists');
    }
    return usersRepository.create(input);
  }

  async update(id: string, input: UpdateUserInput): Promise<User | null> {
    if (input.email) {
      const existingUser = await usersRepository.findByEmail(input.email);
      if (existingUser && existingUser.id !== id) {
        throw new Error('Email already in use by another user');
      }
    }
    return usersRepository.update(id, input);
  }

  async delete(id: string): Promise<boolean> {
    return usersRepository.delete(id);
  }
}

export const usersService = new UsersService();
