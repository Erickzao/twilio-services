type TaskTimers = {
  pingTimeout: ReturnType<typeof setTimeout>;
  inactiveTimeout: ReturnType<typeof setTimeout>;
};

export class TaskInactivityScheduler {
  private timers = new Map<string, TaskTimers>();

  has(taskId: string): boolean {
    return this.timers.has(taskId);
  }

  schedule(
    taskId: string,
    greetingSentAt: Date,
    callbacks: {
      onPing: () => void | Promise<void>;
      onInactive: () => void | Promise<void>;
    },
  ): void {
    this.cancel(taskId);

    const now = Date.now();
    const base = greetingSentAt.getTime();

    const msUntilPing = Math.max(0, base + 5_000 - now);
    const msUntilInactive = Math.max(0, base + 30_000 - now);

    const pingTimeout = setTimeout(() => {
      void callbacks.onPing();
    }, msUntilPing);

    const inactiveTimeout = setTimeout(() => {
      void callbacks.onInactive();
    }, msUntilInactive);

    this.timers.set(taskId, { pingTimeout, inactiveTimeout });
  }

  cancel(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (!existing) return;
    clearTimeout(existing.pingTimeout);
    clearTimeout(existing.inactiveTimeout);
    this.timers.delete(taskId);
  }
}

export const taskInactivityScheduler = new TaskInactivityScheduler();
