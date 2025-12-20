export interface User {
  id: string;
  email: string;
  name: string;
  password_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Session {
  token: string;
  user_id: string;
  user_agent?: string;
  ip_address?: string;
  created_at: Date;
  expires_at: Date;
}

export interface CreateUserInput {
  email: string;
  name: string;
}

export interface UpdateUserInput {
  email?: string;
  name?: string;
}

export interface SignUpInput {
  email: string;
  name: string;
  password: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: Omit<User, "password_hash">;
  token: string;
}

export interface PaginationParams {
  limit?: number;
  pageState?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pageState?: string;
}

export type TaskStatus = "open" | "assigned" | "closed";

export interface Task {
  id: string;
  customer_name: string;
  customer_contact: string;
  operator_id?: string;
  operator_name?: string;
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
  assigned_at?: Date;
  greeting_sent_at?: Date;
  ping_sent_at?: Date;
  inactive_sent_at?: Date;
  last_customer_activity_at?: Date;
  closed_at?: Date;
  close_reason?: string;
}

export interface CreateTaskInput {
  customerName: string;
  customerContact: string;
}

export interface AssignTaskInput {
  operatorId: string;
  operatorName: string;
  sendGreeting?: boolean;
}
