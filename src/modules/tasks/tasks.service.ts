import Twilio from 'twilio';
import { sendSMS } from '@/config/twilio';
import type { CreateTaskInput, Task, TaskStatus } from '@/shared/types';
import { createLogger } from '@/shared/utils/logger';
import { flexTasksRepository } from './flex.tasks.repository';
import {
  inactivityCloseMessage,
  operatorHandoffMessage,
  stillInChatMessage,
} from './tasks.messages';
import { tasksRepository } from './tasks.repository';
import { taskInactivityScheduler } from './tasks.scheduler';

const logger = createLogger('TasksService');

type StartHandoffOptions = {
  sendGreeting?: boolean;
};

export class TasksService {
  private twilioClient: Twilio.Twilio | null = null;
  private workspaceSid: string | null = null;
  private twilioConfigWarned = false;
  private workspaceResolveWarned = false;
  private workerNameCache = new Map<string, string>();
  private warnedWorkerParticipantMissing = new Set<string>();

  async create(input: CreateTaskInput): Promise<Task> {
    return tasksRepository.create(input);
  }

  async getById(id: string): Promise<Task | null> {
    return tasksRepository.findById(id);
  }

  async list(filters?: {
    limit?: number;
    operatorId?: string;
    status?: TaskStatus;
  }): Promise<Task[]> {
    const tasks = filters?.status
      ? await tasksRepository.findByStatus(filters.status, filters?.limit)
      : await tasksRepository.findAll(filters?.limit);

    return tasks.filter((task) => {
      if (filters?.operatorId && task.operator_id !== filters.operatorId) return false;
      if (filters?.status && task.status !== filters.status) return false;
      return true;
    });
  }

  /**
   * Processa automaticamente:
   * - Tasks "internas" (tabela `tasks`) quando TASKS_AUTO_SOURCE=internal
   * - Tasks do Twilio Flex/TaskRouter quando TASKS_AUTO_SOURCE=flex
   * - Auto-detect quando TASKS_AUTO_SOURCE=auto (default)
   */
  async autoProcessAssignedTasks(): Promise<void> {
    const source = (process.env.TASKS_AUTO_SOURCE || 'auto').toLowerCase();

    if (source !== 'internal') {
      const processedFlex = await this.autoProcessFlexAssignedTasks();
      if (processedFlex || source === 'flex') return;
    }

    if (source !== 'flex') {
      await this.autoProcessInternalAssignedTasks();
    }
  }

  // ================================
  // Internal tasks (Scylla `tasks`)
  // ================================

  private async autoProcessInternalAssignedTasks(): Promise<void> {
    const batchSize = Number(process.env.TASKS_AUTO_BATCH_SIZE) || 100;
    const assignedTasks = await tasksRepository.findByStatus('assigned', batchSize);

    for (const task of assignedTasks) {
      if (task.status !== 'assigned') continue;
      if (!task.operator_id || !task.operator_name) continue;

      if (task.greeting_sent_at) {
        if (
          task.last_customer_activity_at &&
          task.last_customer_activity_at > task.greeting_sent_at
        ) {
          taskInactivityScheduler.cancel(task.id);
          continue;
        }

        if (task.inactive_sent_at) {
          taskInactivityScheduler.cancel(task.id);
          continue;
        }

        this.scheduleInternalInactivityTimers(task);
        continue;
      }

      const ok = await sendSMS(
        task.customer_contact,
        operatorHandoffMessage(task.customer_name, task.operator_name),
      );

      if (!ok) {
        logger.warn(`Failed to send operator handoff message for task ${task.id}`);
        continue;
      }

      const greetingSentAt = new Date();
      const updated = await tasksRepository.setGreetingSent(task.id, greetingSentAt);
      if (!updated) continue;

      this.scheduleInternalInactivityTimers(updated);
    }
  }

  async assign(taskId: string, operatorId: string, operatorName: string): Promise<Task> {
    const updated = await tasksRepository.assignToOperator(taskId, operatorId, operatorName);
    if (!updated) {
      throw new Error('Task not found');
    }
    return updated;
  }

  async startOperatorHandoff(
    taskId: string,
    operatorId: string,
    operatorName: string,
    options: StartHandoffOptions = {},
  ): Promise<Task> {
    const assigned = await this.assign(taskId, operatorId, operatorName);

    const shouldSendGreeting = options.sendGreeting ?? true;

    if (shouldSendGreeting) {
      const ok = await sendSMS(
        assigned.customer_contact,
        operatorHandoffMessage(assigned.customer_name, operatorName),
      );
      if (!ok) {
        throw new Error('Failed to send operator handoff message');
      }
    }

    const greetingSentAt = new Date();
    const updated = await tasksRepository.setGreetingSent(taskId, greetingSentAt);
    if (!updated) {
      throw new Error('Task not found');
    }

    this.scheduleInternalInactivityTimers(updated);
    return updated;
  }

  async registerOperatorGreeting(taskId: string): Promise<Task> {
    const task = await tasksRepository.findById(taskId);
    if (!task) {
      throw new Error('Task not found');
    }
    if (task.status !== 'assigned') {
      throw new Error('Task is not assigned to an operator');
    }

    const updated = await tasksRepository.setGreetingSent(taskId, new Date());
    if (!updated) {
      throw new Error('Task not found');
    }

    this.scheduleInternalInactivityTimers(updated);
    return updated;
  }

  async markCustomerActivity(taskId: string): Promise<Task> {
    const updated = await tasksRepository.markCustomerActivity(taskId, new Date());
    if (!updated) {
      throw new Error('Task not found');
    }

    taskInactivityScheduler.cancel(taskId);
    return updated;
  }

  async markCustomerActivityByContact(customerContact: string): Promise<void> {
    const candidates = await tasksRepository.findAssignedByCustomerContact(customerContact);
    if (candidates.length === 0) return;

    const latest = candidates.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())[0];
    if (!latest) return;

    await tasksRepository.markCustomerActivity(latest.id, new Date());
    taskInactivityScheduler.cancel(latest.id);
  }

  private scheduleInternalInactivityTimers(task: Task): void {
    const greetingSentAt = task.greeting_sent_at;
    if (!greetingSentAt) return;
    if (taskInactivityScheduler.has(task.id)) return;

    taskInactivityScheduler.schedule(task.id, greetingSentAt, {
      onPing: async () => this.sendInternalPingIfInactive(task.id),
      onInactive: async () => this.sendInternalInactiveAndClose(task.id),
    });
  }

  private async sendInternalPingIfInactive(taskId: string): Promise<void> {
    const task = await tasksRepository.findById(taskId);
    if (!task) return;

    if (task.status !== 'assigned') return;
    if (!task.greeting_sent_at) return;
    if (task.ping_sent_at) return;

    const lastActivity = task.last_customer_activity_at;
    if (lastActivity && lastActivity > task.greeting_sent_at) return;

    const ok = await sendSMS(task.customer_contact, stillInChatMessage(task.customer_name));
    if (!ok) {
      logger.warn(`Failed to send ping message for task ${taskId}`);
      return;
    }

    await tasksRepository.markPingSent(taskId, new Date());
  }

  private async sendInternalInactiveAndClose(taskId: string): Promise<void> {
    const task = await tasksRepository.findById(taskId);
    if (!task) return;

    if (task.status !== 'assigned') return;
    if (!task.greeting_sent_at) return;
    if (task.inactive_sent_at) return;

    const lastActivity = task.last_customer_activity_at;
    if (lastActivity && lastActivity > task.greeting_sent_at) return;

    const ok = await sendSMS(task.customer_contact, inactivityCloseMessage(task.customer_name));
    if (!ok) {
      logger.warn(`Failed to send inactivity message for task ${taskId}`);
      return;
    }

    await tasksRepository.closeDueToInactivity(taskId, new Date());
    taskInactivityScheduler.cancel(taskId);
  }

  // ======================================
  // Flex/TaskRouter tasks + Conversations
  // ======================================

  private getTwilioClient(): Twilio.Twilio | null {
    if (this.twilioClient) return this.twilioClient;

    const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
    const authToken = process.env.TWILIO_AUTH_TOKEN || '';
    if (!accountSid || !authToken) {
      if (!this.twilioConfigWarned) {
        this.twilioConfigWarned = true;
        logger.warn(
          'Twilio credentials not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN).',
          'Flex',
        );
      }
      return null;
    }

    this.twilioClient = Twilio(accountSid, authToken);
    return this.twilioClient;
  }

  private async resolveWorkspaceSid(client: Twilio.Twilio): Promise<string | null> {
    if (this.workspaceSid) return this.workspaceSid;

    const configured = process.env.TWILIO_TASKROUTER_WORKSPACE_SID;
    if (configured) {
      this.workspaceSid = configured;
      logger.log(`TaskRouter workspace configured: ${configured}`, 'Flex');
      return configured;
    }

    const workspaces = await client.taskrouter.v1.workspaces.list({
      limit: 50,
    });
    if (workspaces.length === 1) {
      this.workspaceSid = workspaces[0]?.sid ?? null;
      if (this.workspaceSid) {
        logger.log(`TaskRouter workspace autodetected: ${this.workspaceSid}`, 'Flex');
      }
      return this.workspaceSid;
    }

    const flexCandidates = workspaces.filter((w) =>
      (w.friendlyName || '').toLowerCase().includes('flex'),
    );
    if (flexCandidates.length === 1) {
      this.workspaceSid = flexCandidates[0]?.sid ?? null;
      if (this.workspaceSid) {
        logger.log(`TaskRouter workspace autodetected: ${this.workspaceSid}`, 'Flex');
      }
      return this.workspaceSid;
    }

    if (!this.workspaceResolveWarned) {
      this.workspaceResolveWarned = true;
      const choices = workspaces
        .map((w) => `${w.sid}${w.friendlyName ? ` (${w.friendlyName})` : ''}`)
        .join(', ');
      logger.warn(
        `Could not resolve TaskRouter workspace. Set TWILIO_TASKROUTER_WORKSPACE_SID to enable Flex automation. Available: ${choices}`,
        'Flex',
      );
    }
    return null;
  }

  private getAutomationAuthor(): string {
    return process.env.TASKS_AUTOMATION_AUTHOR || 'System';
  }

  private parseTaskAttributes(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private pickWorkerNameFromAttributes(attrs: Record<string, unknown>): string | undefined {
    const candidates = [attrs.full_name, attrs.fullName, attrs.fullname, attrs.name];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private pickWorkerSidFromAttributes(attrs: Record<string, unknown>): string | undefined {
    const candidates = [attrs.workerSid, attrs.worker_sid, attrs.worker_id, attrs.workerId];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private async resolveWorkerParticipantIdentity(
    client: Twilio.Twilio,
    conversationSid: string,
    workerSid: string | undefined,
    hints?: {
      workerName?: string;
      customerAddress?: string;
      customerFrom?: string;
    },
  ): Promise<string | null> {
    try {
      const participants = await client.conversations.v1
        .conversations(conversationSid)
        .participants.list({ limit: 50 });
      const normalize = (value?: string) => value?.trim().toLowerCase() ?? '';
      const normalizedWorkerSid = normalize(workerSid);
      const normalizedWorkerName = normalize(hints?.workerName);
      const hasWorkerSid = normalizedWorkerSid.length > 0;
      const workerSidValue = workerSid ?? '';
      const customerMarkers = new Set(
        [hints?.customerAddress, hints?.customerFrom]
          .map((value) => normalize(value))
          .filter(Boolean),
      );

      const isCustomerParticipant = (participant: (typeof participants)[number]): boolean => {
        const identity =
          typeof participant.identity === 'string' ? normalize(participant.identity) : '';
        if (identity && customerMarkers.has(identity)) return true;

        const binding = participant.messagingBinding as { address?: string } | undefined;
        const bindingAddress = normalize(binding?.address);
        if (bindingAddress && customerMarkers.has(bindingAddress)) return true;

        return false;
      };

      for (const participant of participants) {
        const identity =
          typeof participant.identity === 'string' ? participant.identity.trim() : '';
        if (!identity) continue;
        if (hasWorkerSid && normalize(identity) === normalizedWorkerSid) return identity;
      }

      if (normalizedWorkerName) {
        for (const participant of participants) {
          const identity =
            typeof participant.identity === 'string' ? participant.identity.trim() : '';
          if (!identity) continue;
          if (normalize(identity) === normalizedWorkerName) return identity;
        }
      }

      if (hasWorkerSid) {
        for (const participant of participants) {
          const identity =
            typeof participant.identity === 'string' ? participant.identity.trim() : '';
          if (!identity) continue;

          const attrs = this.parseTaskAttributes(participant.attributes || '{}');
          const sidFromAttrs = this.pickWorkerSidFromAttributes(attrs);
          if (sidFromAttrs && normalize(sidFromAttrs) === normalizedWorkerSid) return identity;
        }

        for (const participant of participants) {
          const identity =
            typeof participant.identity === 'string' ? participant.identity.trim() : '';
          if (!identity) continue;

          const rawAttrs = participant.attributes;
          if (typeof rawAttrs === 'string' && rawAttrs.includes(workerSidValue)) {
            return identity;
          }
        }
      }

      const candidateIdentities: string[] = [];
      for (const participant of participants) {
        const identity =
          typeof participant.identity === 'string' ? participant.identity.trim() : '';
        if (!identity) continue;
        if (isCustomerParticipant(participant)) continue;
        candidateIdentities.push(identity);
      }

      if (candidateIdentities.length === 1) {
        return candidateIdentities[0] ?? null;
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to list participants for ${conversationSid}: ${message}`, 'Flex');
      return null;
    }
  }

  private async resolveWorkerDisplayName(
    client: Twilio.Twilio,
    workspaceSid: string,
    workerSid: string | undefined,
    fallbackName: string,
  ): Promise<string> {
    const fallback =
      typeof fallbackName === 'string' && fallbackName.trim().length > 0
        ? fallbackName.trim()
        : 'Atendente';

    if (!workerSid || workerSid.trim().length === 0) return fallback;

    const cached = this.workerNameCache.get(workerSid);
    if (cached) return cached;

    try {
      const worker = await client.taskrouter.v1.workspaces(workspaceSid).workers(workerSid).fetch();

      const attrs = this.parseTaskAttributes(worker.attributes || '{}');
      const fromAttrs = this.pickWorkerNameFromAttributes(attrs);
      const resolved =
        fromAttrs ||
        (typeof worker.friendlyName === 'string' && worker.friendlyName.trim()
          ? worker.friendlyName.trim()
          : fallback);

      this.workerNameCache.set(workerSid, resolved);
      return resolved;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to fetch worker ${workerSid}: ${message}`, 'Flex');
      this.workerNameCache.set(workerSid, fallback);
      return fallback;
    }
  }

  private pickCustomerName(attrs: Record<string, unknown>): string {
    const customers = attrs.customers as Record<string, unknown> | undefined;
    const nameFromCustomers = customers?.name;
    if (typeof nameFromCustomers === 'string' && nameFromCustomers.trim().length > 0) {
      return nameFromCustomers.trim();
    }

    const friendlyName = attrs.friendlyName;
    if (typeof friendlyName === 'string' && friendlyName.trim().length > 0) {
      return friendlyName.trim();
    }

    const from = attrs.from;
    if (typeof from === 'string' && from.trim().length > 0) {
      return from.trim();
    }

    return 'cliente';
  }

  private async sendConversationMessage(
    conversationSid: string,
    body: string,
    author?: string,
  ): Promise<boolean> {
    const client = this.getTwilioClient();
    if (!client) return false;

    try {
      await client.conversations.v1.conversations(conversationSid).messages.create({
        author: author?.trim() || this.getAutomationAuthor(),
        body,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to send conversation message to ${conversationSid}: ${message}`);
      return false;
    }
  }

  private async closeConversation(conversationSid: string): Promise<void> {
    const client = this.getTwilioClient();
    if (!client) return;

    try {
      await client.conversations.v1.conversations(conversationSid).update({ state: 'closed' });
      logger.log(`Conversation ${conversationSid}: closed`, 'Flex');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to close conversation ${conversationSid}: ${message}`, 'Flex');
    }
  }

  private async completeTaskRouterTask(taskSid: string): Promise<void> {
    const client = this.getTwilioClient();
    if (!client) return;

    const workspaceSid = await this.resolveWorkspaceSid(client);
    if (!workspaceSid) return;

    try {
      await client.taskrouter.v1.workspaces(workspaceSid).tasks(taskSid).update({
        assignmentStatus: 'completed',
        reason: 'inactivity',
      });
      logger.log(`TaskRouter task ${taskSid}: completed`, 'Flex');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to complete TaskRouter task ${taskSid}: ${message}`, 'Flex');
    }
  }

  private async autoProcessFlexAssignedTasks(): Promise<boolean> {
    const client = this.getTwilioClient();
    if (!client) return false;

    const workspaceSid = await this.resolveWorkspaceSid(client);
    if (!workspaceSid) return false;

    const limit = Number(process.env.TASKS_FLEX_POLL_LIMIT) || 50;

    const tasks = await client.taskrouter.v1.workspaces(workspaceSid).tasks.list({
      assignmentStatus: ['assigned', 'reserved'],
      limit,
    });

    for (const task of tasks) {
      const attrs = this.parseTaskAttributes(task.attributes);
      const conversationSid = attrs.conversationSid;

      if (typeof conversationSid !== 'string' || !conversationSid.startsWith('CH')) continue;

      const acceptedReservations = await client.taskrouter.v1
        .workspaces(workspaceSid)
        .tasks(task.sid)
        .reservations.list({ reservationStatus: 'accepted', limit: 1 });

      const reservation = acceptedReservations[0];
      if (!reservation) continue;

      const fallbackWorkerName =
        typeof reservation.workerName === 'string' && reservation.workerName.trim()
          ? reservation.workerName.trim()
          : 'Atendente';
      const workerSid = reservation.workerSid || undefined;

      const channelType = attrs.channelType;
      const customerAddress = attrs.customerAddress;
      const customerFrom = attrs.from;

      const customerName = this.pickCustomerName(attrs);

      const existingState = await flexTasksRepository.findByTaskSid(task.sid);

      const storedWorkerName = existingState?.worker_name?.trim();
      let workerName = storedWorkerName;

      if (!workerName) {
        workerName = workerSid
          ? await this.resolveWorkerDisplayName(client, workspaceSid, workerSid, fallbackWorkerName)
          : fallbackWorkerName;
      } else if (workerSid && (workerName === 'Atendente' || workerName === fallbackWorkerName)) {
        workerName = await this.resolveWorkerDisplayName(
          client,
          workspaceSid,
          workerSid,
          fallbackWorkerName,
        );
      }

      await flexTasksRepository.upsertBaseState({
        taskSid: task.sid,
        conversationSid,
        channelType: typeof channelType === 'string' ? channelType : undefined,
        customerName,
        customerAddress: typeof customerAddress === 'string' ? customerAddress : undefined,
        customerFrom: typeof customerFrom === 'string' ? customerFrom : undefined,
        workerSid,
        workerName,
        assignmentStatus: task.assignmentStatus,
        taskAttributes: task.attributes,
      });

      if (existingState?.greeting_sent_at) {
        if (
          existingState.last_customer_activity_at &&
          existingState.last_customer_activity_at > existingState.greeting_sent_at
        ) {
          taskInactivityScheduler.cancel(task.sid);
          continue;
        }

        if (existingState.inactive_sent_at) {
          taskInactivityScheduler.cancel(task.sid);
          continue;
        }

        this.scheduleFlexInactivityTimers(task.sid, existingState.greeting_sent_at);
        continue;
      }

      const workerIdentity = await this.resolveWorkerParticipantIdentity(
        client,
        conversationSid,
        workerSid,
        {
          workerName,
          customerAddress: typeof customerAddress === 'string' ? customerAddress : undefined,
          customerFrom: typeof customerFrom === 'string' ? customerFrom : undefined,
        },
      );
      if (!workerIdentity) {
        if (!this.warnedWorkerParticipantMissing.has(task.sid)) {
          this.warnedWorkerParticipantMissing.add(task.sid);
          logger.warn(
            `Flex task ${task.sid}: worker participant not found in ${conversationSid}; waiting to send greeting`,
            'Flex',
          );
        }
        continue;
      }
      this.warnedWorkerParticipantMissing.delete(task.sid);

      const ok = await this.sendConversationMessage(
        conversationSid,
        operatorHandoffMessage(customerName, workerName),
        workerIdentity,
      );

      if (!ok) continue;

      const greetingSentAt = new Date();
      await flexTasksRepository.setGreetingSent(task.sid, greetingSentAt);
      this.scheduleFlexInactivityTimers(task.sid, greetingSentAt);
      logger.log(`Flex task ${task.sid}: greeting sent`, 'Flex');
    }

    return true;
  }

  async markFlexCustomerActivityByConversationSid(
    conversationSid: string,
    author?: string,
  ): Promise<void> {
    const trimmedAuthor = author?.trim();
    if (!trimmedAuthor) return;

    const state = await flexTasksRepository.findByConversationSid(conversationSid);
    if (!state) return;

    const customerAddress = state.customer_address?.trim();
    const customerFrom = state.customer_from?.trim();
    const hasKnownCustomer = Boolean(customerAddress || customerFrom);

    if (hasKnownCustomer) {
      if (trimmedAuthor !== customerAddress && trimmedAuthor !== customerFrom) return;
    } else {
      if (trimmedAuthor === this.getAutomationAuthor()) return;
      if (state.worker_name && trimmedAuthor === state.worker_name) return;
      if (state.worker_sid && trimmedAuthor === state.worker_sid) return;
    }

    await flexTasksRepository.markCustomerActivity(state.task_sid, new Date());
    taskInactivityScheduler.cancel(state.task_sid);
    logger.log(`Flex task ${state.task_sid}: customer activity detected`, 'Flex');
  }

  private scheduleFlexInactivityTimers(taskSid: string, greetingSentAt: Date): void {
    if (taskInactivityScheduler.has(taskSid)) return;

    taskInactivityScheduler.schedule(taskSid, greetingSentAt, {
      onPing: async () => this.sendFlexPingIfInactive(taskSid),
      onInactive: async () => this.sendFlexInactiveAndClose(taskSid),
    });
  }

  private async sendFlexPingIfInactive(taskSid: string): Promise<void> {
    const task = await flexTasksRepository.findByTaskSid(taskSid);
    if (!task) return;

    if (!task.greeting_sent_at) return;
    if (task.ping_sent_at) return;
    if (!task.conversation_sid) return;

    if (task.last_customer_activity_at && task.last_customer_activity_at > task.greeting_sent_at)
      return;

    const client = this.getTwilioClient();
    if (!client) return;

    const workerIdentity = await this.resolveWorkerParticipantIdentity(
      client,
      task.conversation_sid,
      task.worker_sid,
      {
        workerName: task.worker_name,
        customerAddress: task.customer_address,
        customerFrom: task.customer_from,
      },
    );
    if (!workerIdentity) {
      logger.warn(
        `Flex task ${taskSid}: worker participant not found in ${task.conversation_sid}; skipping ping`,
        'Flex',
      );
      return;
    }

    const ok = await this.sendConversationMessage(
      task.conversation_sid,
      stillInChatMessage(task.customer_name || 'cliente'),
      workerIdentity,
    );
    if (!ok) return;

    await flexTasksRepository.markPingSent(taskSid, new Date());
    logger.log(`Flex task ${taskSid}: ping sent`, 'Flex');
  }

  private async sendFlexInactiveAndClose(taskSid: string): Promise<void> {
    const task = await flexTasksRepository.findByTaskSid(taskSid);
    if (!task) return;

    if (!task.greeting_sent_at) return;
    if (task.inactive_sent_at) return;
    if (!task.conversation_sid) return;

    if (task.last_customer_activity_at && task.last_customer_activity_at > task.greeting_sent_at)
      return;

    const client = this.getTwilioClient();
    if (!client) return;

    const workerIdentity = await this.resolveWorkerParticipantIdentity(
      client,
      task.conversation_sid,
      task.worker_sid,
      {
        workerName: task.worker_name,
        customerAddress: task.customer_address,
        customerFrom: task.customer_from,
      },
    );
    if (!workerIdentity) {
      logger.warn(
        `Flex task ${taskSid}: worker participant not found in ${task.conversation_sid}; skipping inactivity close`,
        'Flex',
      );
      return;
    }

    const ok = await this.sendConversationMessage(
      task.conversation_sid,
      inactivityCloseMessage(task.customer_name || 'cliente'),
      workerIdentity,
    );
    if (!ok) return;

    const now = new Date();
    await flexTasksRepository.markInactiveSent(taskSid, now);
    logger.log(`Flex task ${taskSid}: inactive sent`, 'Flex');

    if (process.env.TASKS_FLEX_CLOSE_CONVERSATION !== 'false') {
      await this.closeConversation(task.conversation_sid);
    }

    if (process.env.TASKS_FLEX_COMPLETE_TASK !== 'false') {
      await this.completeTaskRouterTask(taskSid);
    }

    taskInactivityScheduler.cancel(taskSid);
  }
}

export const tasksService = new TasksService();
