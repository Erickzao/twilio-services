import { createLogger } from '@/shared/utils/logger';
import { tasksService } from './tasks.service';

const logger = createLogger('TasksWorker');

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;

  try {
    await tasksService.autoProcessAssignedTasks();
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);
    logger.error(
      `Unhandled error while processing assigned tasks: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
  } finally {
    running = false;
  }
}

export function startTasksAutoProcessor(): void {
  if (intervalHandle) return;

  const enabled = process.env.TASKS_AUTO_ENABLED !== 'false';
  if (!enabled) {
    logger.warn('Tasks auto processor disabled (TASKS_AUTO_ENABLED=false)');
    return;
  }

  const intervalMs = Number(process.env.TASKS_AUTO_POLL_INTERVAL_MS) || 1_000;

  intervalHandle = setInterval(() => {
    void tick();
  }, intervalMs);

  void tick();
  logger.log(`Tasks auto processor started (interval=${intervalMs}ms)`);
}

export function stopTasksAutoProcessor(): void {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  logger.log('Tasks auto processor stopped');
}
