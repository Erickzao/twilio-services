import Twilio from 'twilio';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('TwilioTaskRouter');

export type TaskRouterWorkflow = {
  sid: string;
  friendlyName: string;
};

export type TaskRouterTaskChannel = {
  sid: string;
  friendlyName: string;
  uniqueName: string;
};

type ListResult<T> =
  | {
      success: true;
      workspaceSid: string;
      data: T[];
    }
  | {
      success: false;
      error: string;
    };

export class TwilioTaskRouterClient {
  private client: Twilio.Twilio | null = null;
  private workspaceSid: string | null = null;
  private twilioConfigWarned = false;
  private workspaceResolveWarned = false;

  private getClient(): Twilio.Twilio | null {
    if (this.client) return this.client;

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      if (!this.twilioConfigWarned) {
        this.twilioConfigWarned = true;
        logger.warn('Twilio credentials not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN).');
      }
      return null;
    }

    this.client = Twilio(accountSid, authToken);
    return this.client;
  }

  async resolveWorkspaceSid(): Promise<string | null> {
    if (this.workspaceSid) return this.workspaceSid;

    const client = this.getClient();
    if (!client) return null;

    const configured = process.env.TWILIO_TASKROUTER_WORKSPACE_SID;
    if (configured) {
      this.workspaceSid = configured;
      logger.log(`TaskRouter workspace configured: ${configured}`);
      return configured;
    }

    const workspaces = await client.taskrouter.v1.workspaces.list({
      limit: 50,
    });

    if (workspaces.length === 1) {
      this.workspaceSid = workspaces[0]?.sid ?? null;
      if (this.workspaceSid) {
        logger.log(`TaskRouter workspace autodetected: ${this.workspaceSid}`);
      }
      return this.workspaceSid;
    }

    const flexCandidates = workspaces.filter((w) =>
      (w.friendlyName || '').toLowerCase().includes('flex'),
    );
    if (flexCandidates.length === 1) {
      this.workspaceSid = flexCandidates[0]?.sid ?? null;
      if (this.workspaceSid) {
        logger.log(`TaskRouter workspace autodetected: ${this.workspaceSid}`);
      }
      return this.workspaceSid;
    }

    if (!this.workspaceResolveWarned) {
      this.workspaceResolveWarned = true;
      const choices = workspaces
        .map((w) => `${w.sid}${w.friendlyName ? ` (${w.friendlyName})` : ''}`)
        .join(', ');
      logger.warn(
        `Could not resolve TaskRouter workspace. Set TWILIO_TASKROUTER_WORKSPACE_SID. Available: ${choices}`,
      );
    }

    return null;
  }

  async listWorkflows(limit = 100): Promise<ListResult<TaskRouterWorkflow>> {
    const client = this.getClient();
    if (!client) return { success: false, error: 'Twilio not configured' };

    const workspaceSid = await this.resolveWorkspaceSid();
    if (!workspaceSid) {
      return {
        success: false,
        error: 'Could not resolve TaskRouter workspace. Set TWILIO_TASKROUTER_WORKSPACE_SID.',
      };
    }

    const workflows = await client.taskrouter.v1.workspaces(workspaceSid).workflows.list({ limit });

    return {
      success: true,
      workspaceSid,
      data: workflows.map((w) => ({
        sid: w.sid,
        friendlyName: w.friendlyName || w.sid,
      })),
    };
  }

  async listTaskChannels(limit = 100): Promise<ListResult<TaskRouterTaskChannel>> {
    const client = this.getClient();
    if (!client) return { success: false, error: 'Twilio not configured' };

    const workspaceSid = await this.resolveWorkspaceSid();
    if (!workspaceSid) {
      return {
        success: false,
        error: 'Could not resolve TaskRouter workspace. Set TWILIO_TASKROUTER_WORKSPACE_SID.',
      };
    }

    const channels = await client.taskrouter.v1
      .workspaces(workspaceSid)
      .taskChannels.list({ limit });

    return {
      success: true,
      workspaceSid,
      data: channels.map((c) => ({
        sid: c.sid,
        friendlyName: c.friendlyName || c.sid,
        uniqueName: c.uniqueName || '',
      })),
    };
  }
}

export const twilioTaskRouterClient = new TwilioTaskRouterClient();
