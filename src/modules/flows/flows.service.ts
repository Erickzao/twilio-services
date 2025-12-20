import type {
  Flow,
  FlowInput,
  FlowNode,
  FlowPreview,
  FlowPublishResult,
  FlowUpdateInput,
  TwilioFlowDefinition,
} from "./flows.types";
import { flowBuilder } from "./flows.builder";
import { flowsRepository } from "./flows.repository";
import { twilioStudioClient } from "./flows.twilio";
import { twilioContentClient } from "./flows.content";
import { createLogger } from "@/shared/utils/logger";
import { createHash } from "crypto";
import { twilioCacheRepository } from "@/modules/twilio-cache/twilio-cache.repository";
import type {
  TaskRouterTaskChannel,
  TaskRouterWorkflow,
} from "./flows.taskrouter";
import { twilioTaskRouterClient } from "./flows.taskrouter";

const logger = createLogger("FlowsService");

export class FlowsService {
  private getTwilioCacheTtlMs(): number {
    const envValue = Number(process.env.TWILIO_CACHE_TTL_MS);
    if (Number.isFinite(envValue) && envValue > 0) return envValue;
    return 60 * 60 * 1000;
  }

  private async getCachedJson<T>(key: string): Promise<{
    value: T;
    updatedAt: Date;
  } | null> {
    try {
      const cached = await twilioCacheRepository.get(key);
      if (!cached) return null;
      const parsed = JSON.parse(cached.value) as T;
      return { value: parsed, updatedAt: cached.updatedAt };
    } catch {
      return null;
    }
  }

  private async setCachedJson(key: string, value: unknown): Promise<void> {
    try {
      await twilioCacheRepository.set(key, JSON.stringify(value));
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      logger.warn(`Failed to write Twilio cache "${key}": ${message}`);
    }
  }

  private buildContentTemplateCacheKey(
    templateType: "quick-reply" | "list-picker",
    body: string,
    buttons: Array<{ id: string; label: string; value: string }>,
    language = "pt_BR",
  ): string {
    const normalized = JSON.stringify({
      templateType,
      language,
      body,
      buttons: buttons.map((b) => ({
        id: b.id,
        label: b.label,
        value: b.value,
      })),
    });

    const hash = createHash("sha256").update(normalized).digest("hex");
    return `content-template:${templateType}:${hash}`;
  }

  async getTaskRouterWorkflows(options?: {
    refresh?: boolean;
    limit?: number;
  }): Promise<{
    workspaceSid: string;
    workflows: TaskRouterWorkflow[];
    cached: boolean;
    cachedAt?: Date;
  }> {
    const workspaceSid = await twilioTaskRouterClient.resolveWorkspaceSid();
    if (!workspaceSid) {
      throw new Error(
        "Could not resolve TaskRouter workspace. Set TWILIO_TASKROUTER_WORKSPACE_SID.",
      );
    }

    const cacheKey = `taskrouter:workflows:${workspaceSid}`;
    const ttlMs = this.getTwilioCacheTtlMs();

    if (!options?.refresh) {
      const cached = await this.getCachedJson<TaskRouterWorkflow[]>(cacheKey);
      if (cached) {
        const age = Date.now() - cached.updatedAt.getTime();
        if (age >= 0 && age < ttlMs) {
          return {
            workspaceSid,
            workflows: cached.value,
            cached: true,
            cachedAt: cached.updatedAt,
          };
        }
      }
    }

    const result = await twilioTaskRouterClient.listWorkflows(options?.limit);
    if (!result.success) {
      throw new Error(result.error);
    }

    await this.setCachedJson(cacheKey, result.data);

    return {
      workspaceSid: result.workspaceSid,
      workflows: result.data,
      cached: false,
    };
  }

  async getTaskRouterTaskChannels(options?: {
    refresh?: boolean;
    limit?: number;
  }): Promise<{
    workspaceSid: string;
    taskChannels: TaskRouterTaskChannel[];
    cached: boolean;
    cachedAt?: Date;
  }> {
    const workspaceSid = await twilioTaskRouterClient.resolveWorkspaceSid();
    if (!workspaceSid) {
      throw new Error(
        "Could not resolve TaskRouter workspace. Set TWILIO_TASKROUTER_WORKSPACE_SID.",
      );
    }

    const cacheKey = `taskrouter:task-channels:${workspaceSid}`;
    const ttlMs = this.getTwilioCacheTtlMs();

    if (!options?.refresh) {
      const cached =
        await this.getCachedJson<TaskRouterTaskChannel[]>(cacheKey);
      if (cached) {
        const age = Date.now() - cached.updatedAt.getTime();
        if (age >= 0 && age < ttlMs) {
          return {
            workspaceSid,
            taskChannels: cached.value,
            cached: true,
            cachedAt: cached.updatedAt,
          };
        }
      }
    }

    const result = await twilioTaskRouterClient.listTaskChannels(
      options?.limit,
    );
    if (!result.success) {
      throw new Error(result.error);
    }

    await this.setCachedJson(cacheKey, result.data);

    return {
      workspaceSid: result.workspaceSid,
      taskChannels: result.data,
      cached: false,
    };
  }

  async listContentTemplates(options?: {
    refresh?: boolean;
    pageSize?: number;
  }): Promise<{
    templates: unknown[];
    cached: boolean;
    cachedAt?: Date;
  }> {
    const pageSize = Math.min(
      Math.max(Math.floor(options?.pageSize ?? 50), 1),
      200,
    );
    const cacheKey = `content-templates:list:${pageSize}`;
    const ttlMs = this.getTwilioCacheTtlMs();

    if (!options?.refresh) {
      const cached = await this.getCachedJson<unknown[]>(cacheKey);
      if (cached) {
        const age = Date.now() - cached.updatedAt.getTime();
        if (age >= 0 && age < ttlMs) {
          return {
            templates: cached.value,
            cached: true,
            cachedAt: cached.updatedAt,
          };
        }
      }
    }

    const result = await twilioContentClient.listTemplates(pageSize);
    if (!result.success || !result.templates) {
      throw new Error(result.error || "Failed to list content templates");
    }

    await this.setCachedJson(cacheKey, result.templates);

    return {
      templates: result.templates,
      cached: false,
    };
  }

  async getAll(limit?: number): Promise<Flow[]> {
    return flowsRepository.findAll(limit);
  }

  async getById(id: string): Promise<Flow | null> {
    return flowsRepository.findById(id);
  }

  async getByTwilioSid(twilioFlowSid: string): Promise<Flow | null> {
    return flowsRepository.findByTwilioSid(twilioFlowSid);
  }

  async create(input: FlowInput): Promise<Flow> {
    this.validateFlowInput(input);
    return flowsRepository.create(input);
  }

  async update(id: string, input: FlowUpdateInput): Promise<Flow | null> {
    const existing = await flowsRepository.findById(id);
    if (!existing) return null;

    if (input.nodes) {
      this.validateNodes(
        input.nodes,
        input.startNodeId || existing.start_node_id,
      );
    }

    return flowsRepository.update(id, input);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await flowsRepository.findById(id);
    if (!existing) return false;

    // Se o flow está publicado na Twilio, deletar lá também
    if (existing.twilio_flow_sid) {
      const result = await twilioStudioClient.deleteFlow(
        existing.twilio_flow_sid,
      );
      if (!result.success) {
        throw new Error(`Failed to delete flow from Twilio: ${result.error}`);
      }
    }

    return flowsRepository.delete(id);
  }

  async preview(id: string): Promise<FlowPreview | null> {
    const flow = await flowsRepository.findById(id);
    if (!flow) return null;

    const twilioDefinition = flowBuilder.build(flow);

    return {
      flow,
      twilioDefinition,
    };
  }

  async buildDefinition(flow: Flow): Promise<TwilioFlowDefinition> {
    return flowBuilder.build(flow);
  }

  async publish(id: string): Promise<FlowPublishResult> {
    const flow = await flowsRepository.findById(id);
    if (!flow) {
      return { success: false, error: "Flow not found" };
    }

    if (!twilioStudioClient.isConfigured()) {
      return { success: false, error: "Twilio credentials not configured" };
    }

    // Criar Content Templates automaticamente para nodes com botões
    const nodesWithTemplates =
      await this.createContentTemplatesForButtons(flow);

    // Criar uma cópia do flow com os Content Template SIDs
    const flowWithTemplates: Flow = {
      ...flow,
      nodes: nodesWithTemplates,
    };

    const definition = flowBuilder.build(flowWithTemplates);

    // Validar antes de publicar
    const validation = await twilioStudioClient.validateFlow(
      flow.name,
      definition,
    );
    if (!validation.valid) {
      await flowsRepository.updateStatus(
        id,
        "error",
        undefined,
        validation.errors?.join(", ") || "Validation failed",
      );
      return {
        success: false,
        error: validation.errors?.join(", ") || "Validation failed",
      };
    }

    let result: { success: boolean; flowSid?: string; error?: string };

    if (flow.twilio_flow_sid) {
      // Atualizar flow existente
      const updateResult = await twilioStudioClient.updateFlow(
        flow.twilio_flow_sid,
        definition,
        "published",
        `Published at ${new Date().toISOString()}`,
      );
      result = {
        success: updateResult.success,
        flowSid: flow.twilio_flow_sid,
        error: updateResult.error,
      };
    } else {
      // Criar novo flow
      result = await twilioStudioClient.createFlow(
        flow.name,
        definition,
        "published",
      );
    }

    if (result.success && result.flowSid) {
      // Atualizar os nodes com os Content Template SIDs no banco
      await flowsRepository.update(id, { nodes: nodesWithTemplates });
      await flowsRepository.updateStatus(id, "published", result.flowSid);
      return { success: true, twilioFlowSid: result.flowSid };
    }

    await flowsRepository.updateStatus(
      id,
      "error",
      flow.twilio_flow_sid,
      result.error,
    );
    return { success: false, error: result.error };
  }

  /**
   * Cria Content Templates na Twilio para todos os nodes do tipo 'buttons'
   * que ainda não têm um contentTemplateSid definido.
   */
  private async createContentTemplatesForButtons(
    flow: Flow,
  ): Promise<FlowNode[]> {
    const updatedNodes: FlowNode[] = [];

    for (const node of flow.nodes) {
      // Se é um node de botões e não tem Content Template ainda
      if (
        node.type === "buttons" &&
        node.buttons &&
        node.buttons.length > 0 &&
        !node.contentTemplateSid
      ) {
        // Twilio Content API limita a 3 botões para quick-reply
        if (node.buttons.length <= 3) {
          const templateButtons = node.buttons.map((btn) => ({
            id: btn.id,
            label: btn.label,
            value: btn.value,
          }));

          const cacheKey = this.buildContentTemplateCacheKey(
            "quick-reply",
            node.content,
            templateButtons,
          );

          const cached = await this.getCachedJson<{ contentSid: string }>(
            cacheKey,
          );
          const cachedSid = cached?.value?.contentSid;
          if (cachedSid) {
            updatedNodes.push({
              ...node,
              contentTemplateSid: cachedSid,
            });
            continue;
          }

          const templateName = `${flow.name}_${node.id}_buttons_${cacheKey.slice(-8)}`;

          logger.log(
            `Creating Content Template for node "${node.id}": ${templateName}`,
          );

          const result = await twilioContentClient.createQuickReplyTemplate(
            templateName,
            node.content,
            templateButtons,
          );

          if (result.success && result.contentSid) {
            logger.log(`Content Template created: ${result.contentSid}`);
            await this.setCachedJson(cacheKey, {
              contentSid: result.contentSid,
              templateType: "quick-reply",
              templateName,
              nodeId: node.id,
              flowName: flow.name,
            });
            updatedNodes.push({
              ...node,
              contentTemplateSid: result.contentSid,
            });
          } else {
            // Se falhar, continuar sem Content Template (fallback para texto)
            logger.warn(
              `Failed to create Content Template for node "${node.id}": ${result.error}`,
            );
            logger.warn("Falling back to text-based buttons");
            updatedNodes.push(node);
          }
        } else {
          if (node.buttons.length <= 10) {
            const templateButtons = node.buttons.map((btn) => ({
              id: btn.id,
              label: btn.label,
              value: btn.value,
            }));

            const cacheKey = this.buildContentTemplateCacheKey(
              "list-picker",
              node.content,
              templateButtons,
            );

            const cached = await this.getCachedJson<{ contentSid: string }>(
              cacheKey,
            );
            const cachedSid = cached?.value?.contentSid;
            if (cachedSid) {
              updatedNodes.push({
                ...node,
                contentTemplateSid: cachedSid,
              });
              continue;
            }

            const templateName = `${flow.name}_${node.id}_buttons_${cacheKey.slice(-8)}`;

            logger.log(
              `Creating List-picker Content Template for node "${node.id}": ${templateName}`,
            );

            const result = await twilioContentClient.createListPickerTemplate(
              templateName,
              node.content,
              templateButtons,
            );

            if (result.success && result.contentSid) {
              logger.log(`Content Template created: ${result.contentSid}`);
              await this.setCachedJson(cacheKey, {
                contentSid: result.contentSid,
                templateType: "list-picker",
                templateName,
                nodeId: node.id,
                flowName: flow.name,
              });
              updatedNodes.push({
                ...node,
                contentTemplateSid: result.contentSid,
              });
              continue;
            }

            logger.warn(
              `Failed to create Content Template for node "${node.id}": ${result.error}`,
            );
            logger.warn("Falling back to text-based buttons");
          }
          // Mais de 3 botões: usar fallback de texto
          logger.warn(
            `Node "${node.id}" has ${node.buttons.length} buttons. Using text fallback.`,
          );
          updatedNodes.push(node);
        }
      } else {
        // Node não é de botões ou já tem Content Template
        updatedNodes.push(node);
      }
    }

    return updatedNodes;
  }

  async unpublish(id: string): Promise<FlowPublishResult> {
    const flow = await flowsRepository.findById(id);
    if (!flow) {
      return { success: false, error: "Flow not found" };
    }

    if (!flow.twilio_flow_sid) {
      return { success: false, error: "Flow is not published on Twilio" };
    }

    if (!twilioStudioClient.isConfigured()) {
      return { success: false, error: "Twilio credentials not configured" };
    }

    const result = await twilioStudioClient.setFlowStatus(
      flow.twilio_flow_sid,
      "draft",
    );

    if (result.success) {
      await flowsRepository.updateStatus(id, "draft");
      return { success: true, twilioFlowSid: flow.twilio_flow_sid };
    }

    return { success: false, error: result.error };
  }

  async validate(id: string): Promise<{ valid: boolean; errors?: string[] }> {
    const flow = await flowsRepository.findById(id);
    if (!flow) {
      return { valid: false, errors: ["Flow not found"] };
    }

    if (!twilioStudioClient.isConfigured()) {
      return { valid: false, errors: ["Twilio credentials not configured"] };
    }

    const definition = flowBuilder.build(flow);
    return twilioStudioClient.validateFlow(flow.name, definition);
  }

  private validateFlowInput(input: FlowInput): void {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error("Flow name is required");
    }

    if (!input.nodes || input.nodes.length === 0) {
      throw new Error("Flow must have at least one node");
    }

    if (!input.startNodeId) {
      throw new Error("Start node ID is required");
    }

    this.validateNodes(input.nodes, input.startNodeId);
  }

  private validateNodes(nodes: FlowInput["nodes"], startNodeId: string): void {
    const nodeIds = new Set(nodes.map((n) => n.id));

    // Verificar se startNodeId existe
    if (!nodeIds.has(startNodeId)) {
      throw new Error(`Start node "${startNodeId}" not found in nodes`);
    }

    // Verificar referências de nextNodeId
    for (const node of nodes) {
      if (node.nextNodeId && !nodeIds.has(node.nextNodeId)) {
        throw new Error(
          `Node "${node.id}" references non-existent node "${node.nextNodeId}"`,
        );
      }

      // Verificar referências em buttons
      if (node.buttons) {
        for (const button of node.buttons) {
          if (!nodeIds.has(button.nextNodeId)) {
            throw new Error(
              `Button "${button.label}" in node "${node.id}" references non-existent node "${button.nextNodeId}"`,
            );
          }
        }
      }
    }

    // Verificar IDs duplicados
    if (nodeIds.size !== nodes.length) {
      throw new Error("Duplicate node IDs found");
    }
  }
}

export const flowsService = new FlowsService();
