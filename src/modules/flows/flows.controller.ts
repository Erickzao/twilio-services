import { Elysia, t } from "elysia";
import { flowsService } from "./flows.service";
import { twilioContentClient } from "./flows.content";
import type { FlowInput, FlowNode } from "./flows.types";

// Schema para posição x,y
const PositionSchema = t.Object({
  x: t.Number(),
  y: t.Number(),
});

// Schema para botão
const ButtonSchema = t.Object({
  id: t.String({ minLength: 1 }),
  label: t.String({ minLength: 1 }),
  value: t.String({ minLength: 1 }),
  nextNodeId: t.String({ minLength: 1 }),
});

// Schema para configuração de transferência
const TransferConfigSchema = t.Optional(
  t.Object({
    workflowSid: t.Optional(t.String()),
    channelSid: t.Optional(t.String()),
    priority: t.Optional(t.Number()),
    timeout: t.Optional(t.Number()),
    attributes: t.Optional(t.Record(t.String(), t.String())),
  }),
);

// Schema para node do flow
const FlowNodeSchema = t.Object({
  id: t.String({ minLength: 1 }),
  type: t.Union([
    t.Literal("message"),
    t.Literal("question"),
    t.Literal("buttons"),
    t.Literal("transfer"),
  ]),
  position: PositionSchema,
  content: t.String({ minLength: 1 }),
  buttons: t.Optional(t.Array(ButtonSchema)),
  nextNodeId: t.Optional(t.String()),
  transferConfig: TransferConfigSchema,
  timeout: t.Optional(t.Number()),
  contentTemplateSid: t.Optional(t.String({ pattern: "^HX[a-f0-9]{32}$" })), // HX SID para Content Templates
});

// Schema para criar flow
const CreateFlowSchema = t.Object({
  name: t.String({ minLength: 1 }),
  description: t.Optional(t.String()),
  nodes: t.Array(FlowNodeSchema, { minItems: 1 }),
  startNodeId: t.String({ minLength: 1 }),
});

// Simple "menu" flow schema (titulo/mensagem/botoes)
const MenuButtonInputSchema = t.Object({
  id: t.String({ minLength: 1 }),
  label: t.String({ minLength: 1 }),
  value: t.String({ minLength: 1 }),
});

const CreateMenuFlowSchema = t.Object({
  titulo: t.String({ minLength: 1 }),
  descricao: t.Optional(t.String()),
  mensagem: t.String({ minLength: 1 }),
  botoes: t.Array(MenuButtonInputSchema, { minItems: 1, maxItems: 10 }),
  publicar: t.Optional(t.Boolean()),
  transferConfig: TransferConfigSchema,
});

// Schema para atualizar flow
const UpdateFlowSchema = t.Object({
  name: t.Optional(t.String({ minLength: 1 })),
  description: t.Optional(t.String()),
  nodes: t.Optional(t.Array(FlowNodeSchema, { minItems: 1 })),
  startNodeId: t.Optional(t.String({ minLength: 1 })),
});

export const flowsController = new Elysia({ prefix: "/flows" })
  // Listar todos os flows
  .get(
    "/",
    async ({ query }) => {
      const flows = await flowsService.getAll(query.limit);
      return { data: flows };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ default: 100 })),
      }),
      detail: {
        summary: "List all flows",
        tags: ["Flows"],
      },
    },
  )

  // Obter flow por ID
  .get(
    "/:id",
    async ({ params, set }) => {
      const flow = await flowsService.getById(params.id);
      if (!flow) {
        set.status = 404;
        return { message: "Flow not found" };
      }
      return { data: flow };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Get flow by ID",
        tags: ["Flows"],
      },
    },
  )

  // Criar novo flow
  .post(
    "/menu",
    async ({ body, set }) => {
      try {
        const menuNodeId = "menu";

        const seenButtonIds = new Set<string>();
        for (const btn of body.botoes) {
          if (seenButtonIds.has(btn.id)) {
            throw new Error(`Duplicate button id: "${btn.id}"`);
          }
          seenButtonIds.add(btn.id);
        }

        const usedNodeIds = new Set<string>([menuNodeId]);
        const transferNodeIdsByButtonId = new Map<string, string>();

        const makeSafeId = (prefix: string, raw: string): string => {
          const base = `${prefix}_${raw}`.replace(/[^a-zA-Z0-9_]/g, "_");
          let candidate = base;
          let counter = 1;
          while (usedNodeIds.has(candidate)) {
            candidate = `${base}_${counter}`;
            counter++;
          }
          usedNodeIds.add(candidate);
          return candidate;
        };

        const transferNodes: FlowNode[] = body.botoes.map((btn) => {
          const transferNodeId = makeSafeId("transfer", btn.id);
          transferNodeIdsByButtonId.set(btn.id, transferNodeId);

          const baseConfig = body.transferConfig || {};
          const mergedAttributes = {
            ...(baseConfig.attributes || {}),
            selected_button_id: btn.id,
            selected_button_value: btn.value,
            selected_button_label: btn.label,
          };

          return {
            id: transferNodeId,
            type: "transfer",
            position: { x: 0, y: 0 },
            content: "Transferindo...",
            transferConfig: {
              ...baseConfig,
              priority: baseConfig.priority ?? 1,
              timeout: baseConfig.timeout ?? 3600,
              attributes: mergedAttributes,
            },
          };
        });

        const menuButtons = body.botoes.map((btn) => {
          const nextNodeId = transferNodeIdsByButtonId.get(btn.id);
          if (!nextNodeId) {
            throw new Error(`Failed to create transfer node for "${btn.id}"`);
          }
          return {
            id: btn.id,
            label: btn.label,
            value: btn.value,
            nextNodeId,
          };
        });

        const input: FlowInput = {
          name: body.titulo,
          description: body.descricao,
          startNodeId: menuNodeId,
          nodes: [
            {
              id: menuNodeId,
              type: "buttons",
              position: { x: 0, y: 0 },
              content: body.mensagem,
              buttons: menuButtons,
              timeout: 3600,
            } as FlowNode,
            ...transferNodes,
          ],
        };

        const flow = await flowsService.create(input);

        const shouldPublish = body.publicar !== false;
        if (!shouldPublish) {
          set.status = 201;
          return { data: flow };
        }

        const publishResult = await flowsService.publish(flow.id);
        if (!publishResult.success) {
          set.status = 400;
          return {
            message: publishResult.error || "Failed to publish flow",
            data: flow,
          };
        }

        const updated = await flowsService.getById(flow.id);
        set.status = 201;
        return {
          data: updated || flow,
          twilioFlowSid: publishResult.twilioFlowSid,
        };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error ? err.message : "Failed to create menu flow";
        return { message };
      }
    },
    {
      body: CreateMenuFlowSchema,
      detail: {
        summary: "Create a menu flow from titulo/mensagem/botoes",
        tags: ["Flows"],
      },
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      try {
        const flow = await flowsService.create(body);
        set.status = 201;
        return { data: flow };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error ? err.message : "Failed to create flow";
        return { message };
      }
    },
    {
      body: CreateFlowSchema,
      detail: {
        summary: "Create a new flow",
        tags: ["Flows"],
      },
    },
  )

  // Atualizar flow
  .put(
    "/:id",
    async ({ params, body, set }) => {
      try {
        const flow = await flowsService.update(params.id, body);
        if (!flow) {
          set.status = 404;
          return { message: "Flow not found" };
        }
        return { data: flow };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error ? err.message : "Failed to update flow";
        return { message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: UpdateFlowSchema,
      detail: {
        summary: "Update flow by ID",
        tags: ["Flows"],
      },
    },
  )

  // Deletar flow
  .delete(
    "/:id",
    async ({ params, set }) => {
      try {
        const deleted = await flowsService.delete(params.id);
        if (!deleted) {
          set.status = 404;
          return { message: "Flow not found" };
        }
        return { message: "Flow deleted successfully" };
      } catch (err) {
        set.status = 500;
        const message =
          err instanceof Error ? err.message : "Failed to delete flow";
        return { message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Delete flow by ID",
        tags: ["Flows"],
      },
    },
  )

  // Preview do JSON Twilio (sem publicar)
  .get(
    "/:id/preview",
    async ({ params, set }) => {
      const preview = await flowsService.preview(params.id);
      if (!preview) {
        set.status = 404;
        return { message: "Flow not found" };
      }
      return { data: preview };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Preview Twilio JSON definition without publishing",
        tags: ["Flows"],
      },
    },
  )

  // Validar flow contra Twilio
  .post(
    "/:id/validate",
    async ({ params, set }) => {
      const result = await flowsService.validate(params.id);
      if (!result.valid) {
        set.status = 400;
        return { message: "Validation failed", errors: result.errors };
      }
      return { message: "Flow is valid", valid: true };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Validate flow against Twilio schema",
        tags: ["Flows"],
      },
    },
  )

  // Publicar flow na Twilio
  .post(
    "/:id/publish",
    async ({ params, set }) => {
      const result = await flowsService.publish(params.id);
      if (!result.success) {
        set.status = 400;
        return { message: result.error || "Failed to publish flow" };
      }
      return {
        message: "Flow published successfully",
        data: { twilioFlowSid: result.twilioFlowSid },
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Publish flow to Twilio Studio",
        tags: ["Flows"],
      },
    },
  )

  // Despublicar flow (colocar em draft)
  .post(
    "/:id/unpublish",
    async ({ params, set }) => {
      const result = await flowsService.unpublish(params.id);
      if (!result.success) {
        set.status = 400;
        return { message: result.error || "Failed to unpublish flow" };
      }
      return {
        message: "Flow unpublished successfully (now in draft)",
        data: { twilioFlowSid: result.twilioFlowSid },
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Unpublish flow (set to draft in Twilio)",
        tags: ["Flows"],
      },
    },
  )

  // Listar Workflows (TaskRouter)
  .get(
    "/taskrouter/workflows",
    async ({ query, set }) => {
      try {
        const refresh = Boolean(query.refresh && query.refresh > 0);
        const limit = query.limit ? Number(query.limit) : undefined;

        const result = await flowsService.getTaskRouterWorkflows({
          refresh,
          limit,
        });

        return {
          data: result.workflows,
          workspaceSid: result.workspaceSid,
          cached: result.cached,
          cachedAt: result.cachedAt?.toISOString(),
        };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error ? err.message : "Failed to list workflows";
        return { message };
      }
    },
    {
      query: t.Object({
        refresh: t.Optional(t.Numeric({ default: 0 })),
        limit: t.Optional(t.Numeric({ default: 100 })),
      }),
      detail: {
        summary: "List TaskRouter Workflows (cached)",
        tags: ["Flows"],
      },
    },
  )

  // Listar Task Channels (TaskRouter)
  .get(
    "/taskrouter/task-channels",
    async ({ query, set }) => {
      try {
        const refresh = Boolean(query.refresh && query.refresh > 0);
        const limit = query.limit ? Number(query.limit) : undefined;

        const result = await flowsService.getTaskRouterTaskChannels({
          refresh,
          limit,
        });

        return {
          data: result.taskChannels,
          workspaceSid: result.workspaceSid,
          cached: result.cached,
          cachedAt: result.cachedAt?.toISOString(),
        };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error ? err.message : "Failed to list task channels";
        return { message };
      }
    },
    {
      query: t.Object({
        refresh: t.Optional(t.Numeric({ default: 0 })),
        limit: t.Optional(t.Numeric({ default: 100 })),
      }),
      detail: {
        summary: "List TaskRouter Task Channels (cached)",
        tags: ["Flows"],
      },
    },
  )

  // Listar Content Templates da Twilio
  .get(
    "/content-templates",
    async ({ query, set }) => {
      try {
        const refresh = Boolean(query.refresh && query.refresh > 0);
        const pageSize = query.pageSize ? Number(query.pageSize) : undefined;

        const result = await flowsService.listContentTemplates({
          refresh,
          pageSize,
        });

        return {
          data: result.templates,
          cached: result.cached,
          cachedAt: result.cachedAt?.toISOString(),
        };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error
            ? err.message
            : "Failed to list content templates";
        return { message };
      }
    },
    {
      query: t.Object({
        refresh: t.Optional(t.Numeric({ default: 0 })),
        pageSize: t.Optional(t.Numeric({ default: 50 })),
      }),
      detail: {
        summary: "List Twilio Content Templates (cached)",
        tags: ["Flows"],
      },
    },
  )

  // Criar Content Template de teste
  .post(
    "/content-templates/test",
    async ({ set }) => {
      const result = await twilioContentClient.createQuickReplyTemplate(
        "test_template_" + Date.now(),
        "Teste de template com botões",
        [
          { id: "btn1", label: "Opção 1", value: "opcao1" },
          { id: "btn2", label: "Opção 2", value: "opcao2" },
        ],
      );
      if (!result.success) {
        set.status = 400;
        return { message: result.error || "Failed to create content template" };
      }
      return { data: { contentSid: result.contentSid } };
    },
    {
      detail: {
        summary: "Create test Content Template",
        tags: ["Flows"],
      },
    },
  );
