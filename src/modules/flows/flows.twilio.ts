import Twilio from "twilio";
import { createLogger } from "@/shared/utils/logger";
import type { TwilioFlowDefinition } from "./flows.types";

const logger = createLogger("TwilioStudio");

interface TwilioConfig {
  accountSid: string;
  authToken: string;
}

interface CreateFlowResult {
  success: boolean;
  flowSid?: string;
  error?: string;
}

interface UpdateFlowResult {
  success: boolean;
  error?: string;
}

interface DeleteFlowResult {
  success: boolean;
  error?: string;
}

interface ValidateFlowResult {
  valid: boolean;
  errors?: string[];
}

export class TwilioStudioClient {
  private client: Twilio.Twilio | null = null;
  private config: TwilioConfig;

  constructor() {
    this.config = {
      accountSid: process.env.TWILIO_ACCOUNT_SID || "",
      authToken: process.env.TWILIO_AUTH_TOKEN || "",
    };
  }

  private getClient(): Twilio.Twilio | null {
    if (!this.config.accountSid || !this.config.authToken) {
      logger.warn(
        "Twilio credentials not configured. Studio features will be disabled.",
      );
      return null;
    }

    if (!this.client) {
      this.client = Twilio(this.config.accountSid, this.config.authToken);
      logger.log("Twilio Studio client initialized");
    }

    return this.client;
  }

  async createFlow(
    friendlyName: string,
    definition: TwilioFlowDefinition,
    status: "draft" | "published" = "draft",
  ): Promise<CreateFlowResult> {
    const client = this.getClient();

    if (!client) {
      return {
        success: false,
        error: "Twilio client not initialized. Check credentials.",
      };
    }

    try {
      const flow = await client.studio.v2.flows.create({
        friendlyName,
        status,
        definition: definition as unknown as Record<string, unknown>,
        commitMessage: `Created via API: ${friendlyName}`,
      });

      logger.log(`Flow created successfully. SID: ${flow.sid}`);

      return {
        success: true,
        flowSid: flow.sid,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create flow: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async updateFlow(
    flowSid: string,
    definition: TwilioFlowDefinition,
    status: "draft" | "published" = "published",
    commitMessage?: string,
  ): Promise<UpdateFlowResult> {
    const client = this.getClient();

    if (!client) {
      return {
        success: false,
        error: "Twilio client not initialized. Check credentials.",
      };
    }

    try {
      await client.studio.v2.flows(flowSid).update({
        status,
        definition: definition as unknown as Record<string, unknown>,
        commitMessage:
          commitMessage || `Updated via API at ${new Date().toISOString()}`,
      });

      logger.log(`Flow ${flowSid} updated successfully`);

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to update flow ${flowSid}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async deleteFlow(flowSid: string): Promise<DeleteFlowResult> {
    const client = this.getClient();

    if (!client) {
      return {
        success: false,
        error: "Twilio client not initialized. Check credentials.",
      };
    }

    try {
      await client.studio.v2.flows(flowSid).remove();
      logger.log(`Flow ${flowSid} deleted successfully`);

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to delete flow ${flowSid}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async getFlow(flowSid: string): Promise<{
    success: boolean;
    flow?: {
      sid: string;
      friendlyName: string;
      status: string;
      definition: TwilioFlowDefinition;
    };
    error?: string;
  }> {
    const client = this.getClient();

    if (!client) {
      return {
        success: false,
        error: "Twilio client not initialized. Check credentials.",
      };
    }

    try {
      const flow = await client.studio.v2.flows(flowSid).fetch();

      return {
        success: true,
        flow: {
          sid: flow.sid,
          friendlyName: flow.friendlyName,
          status: flow.status,
          definition: flow.definition as unknown as TwilioFlowDefinition,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to fetch flow ${flowSid}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async validateFlow(
    friendlyName: string,
    definition: TwilioFlowDefinition,
  ): Promise<ValidateFlowResult> {
    const client = this.getClient();

    if (!client) {
      return {
        valid: false,
        errors: ["Twilio client not initialized. Check credentials."],
      };
    }

    try {
      const result = await client.studio.v2.flowValidate.update({
        friendlyName,
        status: "draft",
        definition: definition as unknown as Record<string, unknown>,
      });

      return {
        valid: result.valid,
      };
    } catch (error: unknown) {
      let errorMessage = "Unknown error";
      const errors: string[] = [];

      if (error && typeof error === "object") {
        const twilioError = error as {
          message?: string;
          details?: Record<string, unknown>;
          moreInfo?: string;
        };

        errorMessage = twilioError.message || errorMessage;

        // Log detalhes do erro da Twilio
        if (twilioError.details) {
          logger.error(
            `Validation details: ${JSON.stringify(twilioError.details, null, 2)}`,
          );
          errors.push(JSON.stringify(twilioError.details));
        }

        if (twilioError.moreInfo) {
          logger.error(`More info: ${twilioError.moreInfo}`);
        }
      }

      logger.error(`Flow validation failed: ${errorMessage}`);

      return {
        valid: false,
        errors: errors.length > 0 ? errors : [errorMessage],
      };
    }
  }

  async setFlowStatus(
    flowSid: string,
    status: "draft" | "published",
  ): Promise<UpdateFlowResult> {
    const client = this.getClient();

    if (!client) {
      return {
        success: false,
        error: "Twilio client not initialized. Check credentials.",
      };
    }

    try {
      // Primeiro buscar o flow atual para obter a definition
      const currentFlow = await client.studio.v2.flows(flowSid).fetch();

      await client.studio.v2.flows(flowSid).update({
        status,
        definition: currentFlow.definition,
        commitMessage: `Status changed to ${status} via API`,
      });

      logger.log(`Flow ${flowSid} status changed to ${status}`);

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to change flow ${flowSid} status: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  isConfigured(): boolean {
    return Boolean(this.config.accountSid && this.config.authToken);
  }
}

export const twilioStudioClient = new TwilioStudioClient();
