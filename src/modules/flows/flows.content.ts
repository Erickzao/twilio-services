import { createLogger } from "@/shared/utils/logger";

const logger = createLogger("TwilioContent");

interface ContentConfig {
  accountSid: string;
  authToken: string;
}

interface QuickReplyAction {
  id: string;
  title: string;
}

interface ContentTemplateRequest {
  friendly_name: string;
  language: string;
  types: Record<string, unknown>;
}

interface ContentTemplateResponse {
  sid: string;
  account_sid: string;
  friendly_name: string;
  language: string;
  date_created: string;
  date_updated: string;
  types: Record<string, unknown>;
}

interface CreateContentResult {
  success: boolean;
  contentSid?: string;
  error?: string;
}

interface DeleteContentResult {
  success: boolean;
  error?: string;
}

export class TwilioContentClient {
  private config: ContentConfig;
  private baseUrl = "https://content.twilio.com/v1";

  constructor() {
    this.config = {
      accountSid: process.env.TWILIO_ACCOUNT_SID || "",
      authToken: process.env.TWILIO_AUTH_TOKEN || "",
    };
  }

  private getAuthHeader(): string {
    const credentials = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString("base64");
    return `Basic ${credentials}`;
  }

  /**
   * Cria um Content Template do tipo quick-reply para botões interativos
   */
  async createQuickReplyTemplate(
    friendlyName: string,
    bodyText: string,
    buttons: Array<{ id: string; label: string; value: string }>,
    language = "pt_BR",
  ): Promise<CreateContentResult> {
    if (!this.config.accountSid || !this.config.authToken) {
      return {
        success: false,
        error: "Twilio credentials not configured.",
      };
    }

    // Twilio limita a 3 botões para quick-reply
    if (buttons.length > 3) {
      return {
        success: false,
        error: "Quick-reply templates support a maximum of 3 buttons.",
      };
    }

    if (buttons.length === 0) {
      return {
        success: false,
        error: "At least one button is required.",
      };
    }

    const actions: QuickReplyAction[] = buttons.map((btn) => ({
      id: btn.id,
      title: btn.label.substring(0, 25), // Twilio limita a 25 caracteres
    }));

    const requestBody: ContentTemplateRequest = {
      friendly_name: friendlyName,
      language,
      types: {
        "twilio/quick-reply": {
          body: bodyText,
          actions,
        },
        "twilio/text": {
          body: bodyText, // Fallback para canais que não suportam quick-reply
        },
      },
    };

    try {
      const response = await fetch(`${this.baseUrl}/Content`, {
        method: "POST",
        headers: {
          Authorization: this.getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        const errorMessage =
          errorData.message ||
          `HTTP ${response.status}: ${response.statusText}`;
        logger.error(`Failed to create content template: ${errorMessage}`);
        logger.error(`Response: ${JSON.stringify(errorData)}`);

        return {
          success: false,
          error: errorMessage,
        };
      }

      const data = (await response.json()) as ContentTemplateResponse;
      logger.log(`Content template created successfully. SID: ${data.sid}`);

      return {
        success: true,
        contentSid: data.sid,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create content template: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async createListPickerTemplate(
    friendlyName: string,
    bodyText: string,
    buttons: Array<{ id: string; label: string; value: string }>,
    language = "pt_BR",
  ): Promise<CreateContentResult> {
    if (!this.config.accountSid || !this.config.authToken) {
      return {
        success: false,
        error: "Twilio credentials not configured.",
      };
    }

    const MAX_ITEMS = 10;

    if (buttons.length > MAX_ITEMS) {
      return {
        success: false,
        error: `List-picker templates support a maximum of ${MAX_ITEMS} items.`,
      };
    }

    if (buttons.length === 0) {
      return {
        success: false,
        error: "At least one button is required.",
      };
    }

    const items = buttons.map((btn) => ({
      id: btn.id,
      item: btn.label.substring(0, 24),
      description: (btn.value || btn.label).substring(0, 72),
      media_url: null,
    }));

    const requestBody: ContentTemplateRequest = {
      friendly_name: friendlyName,
      language,
      types: {
        "twilio/list-picker": {
          body: bodyText,
          button: "Selecione uma opcao",
          items,
          multiple_selection: null,
        },
        "twilio/text": {
          body: bodyText,
        },
      },
    };

    try {
      const response = await fetch(`${this.baseUrl}/Content`, {
        method: "POST",
        headers: {
          Authorization: this.getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        const errorMessage =
          errorData.message ||
          `HTTP ${response.status}: ${response.statusText}`;
        logger.error(`Failed to create list-picker template: ${errorMessage}`);
        logger.error(`Response: ${JSON.stringify(errorData)}`);

        return {
          success: false,
          error: errorMessage,
        };
      }

      const data = (await response.json()) as ContentTemplateResponse;
      logger.log(`List-picker template created successfully. SID: ${data.sid}`);

      return {
        success: true,
        contentSid: data.sid,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create list-picker template: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Deleta um Content Template
   */
  async deleteTemplate(contentSid: string): Promise<DeleteContentResult> {
    if (!this.config.accountSid || !this.config.authToken) {
      return {
        success: false,
        error: "Twilio credentials not configured.",
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/Content/${contentSid}`, {
        method: "DELETE",
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });

      if (!response.ok && response.status !== 204) {
        const errorData = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        const errorMessage =
          errorData.message ||
          `HTTP ${response.status}: ${response.statusText}`;
        logger.error(`Failed to delete content template: ${errorMessage}`);

        return {
          success: false,
          error: errorMessage,
        };
      }

      logger.log(`Content template ${contentSid} deleted successfully`);

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to delete content template: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Busca um Content Template por SID
   */
  async getTemplate(contentSid: string): Promise<{
    success: boolean;
    template?: ContentTemplateResponse;
    error?: string;
  }> {
    if (!this.config.accountSid || !this.config.authToken) {
      return {
        success: false,
        error: "Twilio credentials not configured.",
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/Content/${contentSid}`, {
        method: "GET",
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        const errorMessage =
          errorData.message ||
          `HTTP ${response.status}: ${response.statusText}`;

        return {
          success: false,
          error: errorMessage,
        };
      }

      const data = (await response.json()) as ContentTemplateResponse;

      return {
        success: true,
        template: data,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Lista todos os Content Templates
   */
  async listTemplates(pageSize = 50): Promise<{
    success: boolean;
    templates?: ContentTemplateResponse[];
    error?: string;
  }> {
    if (!this.config.accountSid || !this.config.authToken) {
      return {
        success: false,
        error: "Twilio credentials not configured.",
      };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/Content?PageSize=${pageSize}`,
        {
          method: "GET",
          headers: {
            Authorization: this.getAuthHeader(),
          },
        },
      );

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        const errorMessage =
          errorData.message ||
          `HTTP ${response.status}: ${response.statusText}`;

        return {
          success: false,
          error: errorMessage,
        };
      }

      const data = (await response.json()) as {
        contents: ContentTemplateResponse[];
      };

      return {
        success: true,
        templates: data.contents || [],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

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

export const twilioContentClient = new TwilioContentClient();
