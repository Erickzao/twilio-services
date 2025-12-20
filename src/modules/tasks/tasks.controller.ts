import { Elysia, t } from "elysia";
import { tasksService } from "./tasks.service";

export const tasksController = new Elysia({ prefix: "/tasks" })
  .post(
    "/",
    async ({ body, set }) => {
      const task = await tasksService.create(body);
      set.status = 201;
      return { data: task };
    },
    {
      body: t.Object({
        customerName: t.String({ minLength: 1 }),
        customerContact: t.String({ minLength: 1 }),
      }),
      detail: {
        summary: "Create a new task",
        tags: ["Tasks"],
      },
    },
  )
  .get(
    "/",
    async ({ query }) => {
      const tasks = await tasksService.list({
        limit: query.limit,
        operatorId: query.operatorId,
        status: query.status,
      });
      return { data: tasks };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ default: 100 })),
        operatorId: t.Optional(t.String()),
        status: t.Optional(
          t.Union([
            t.Literal("open"),
            t.Literal("assigned"),
            t.Literal("closed"),
          ]),
        ),
      }),
      detail: {
        summary: "List tasks",
        tags: ["Tasks"],
      },
    },
  )
  .get(
    "/:id",
    async ({ params, set }) => {
      const task = await tasksService.getById(params.id);
      if (!task) {
        set.status = 404;
        return { message: "Task not found" };
      }
      return { data: task };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Get task by ID",
        tags: ["Tasks"],
      },
    },
  )
  .post(
    "/:id/assign",
    async ({ params, body, set }) => {
      try {
        const task = await tasksService.assign(
          params.id,
          body.operatorId,
          body.operatorName,
        );
        return { data: task };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error ? err.message : "Failed to assign task";
        return { message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        operatorId: t.String({ minLength: 1 }),
        operatorName: t.String({ minLength: 1 }),
      }),
      detail: {
        summary: "Assign task to an operator",
        tags: ["Tasks"],
      },
    },
  )
  .post(
    "/:id/handoff",
    async ({ params, body, set }) => {
      try {
        const task = await tasksService.startOperatorHandoff(
          params.id,
          body.operatorId,
          body.operatorName,
          {
            sendGreeting: body.sendGreeting,
          },
        );
        return { data: task };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error
            ? err.message
            : "Failed to start operator handoff";
        return { message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        operatorId: t.String({ minLength: 1 }),
        operatorName: t.String({ minLength: 1 }),
        sendGreeting: t.Optional(t.Boolean()),
      }),
      detail: {
        summary: "Send handoff message and start inactivity timers",
        tags: ["Tasks"],
      },
    },
  )
  .post(
    "/:id/greeting",
    async ({ params, set }) => {
      try {
        const task = await tasksService.registerOperatorGreeting(params.id);
        return { data: task };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error ? err.message : "Failed to register greeting";
        return { message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Register greeting (already sent) and start inactivity timers",
        tags: ["Tasks"],
      },
    },
  )
  .post(
    "/:id/activity",
    async ({ params, set }) => {
      try {
        const task = await tasksService.markCustomerActivity(params.id);
        return { data: task };
      } catch (err) {
        set.status = 400;
        const message =
          err instanceof Error
            ? err.message
            : "Failed to mark customer activity";
        return { message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Mark customer activity (cancels inactivity timers)",
        tags: ["Tasks"],
      },
    },
  )
  .post(
    "/twilio/inbound",
    async ({ request, set }) => {
      const raw = await request.text();

      let from = "";
      let conversationSid = "";
      let author = "";

      try {
        const json = JSON.parse(raw) as {
          From?: string;
          from?: string;
          ConversationSid?: string;
          conversationSid?: string;
          Author?: string;
          author?: string;
        };
        from = json.From || json.from || "";
        conversationSid = json.ConversationSid || json.conversationSid || "";
        author = json.Author || json.author || "";
      } catch {
        const params = new URLSearchParams(raw);
        from = params.get("From") || params.get("from") || "";
        conversationSid =
          params.get("ConversationSid") || params.get("conversationSid") || "";
        author = params.get("Author") || params.get("author") || "";
      }

      if (conversationSid) {
        try {
          await tasksService.markFlexCustomerActivityByConversationSid(
            conversationSid,
            author || undefined,
          );
        } catch {
          // Always 200: evita retries em loop.
        }
      } else if (from) {
        try {
          await tasksService.markCustomerActivityByContact(from);
        } catch {
          // Sempre retorna 200 para evitar retries em loop do provedor.
        }
      }

      set.headers["content-type"] = "text/xml; charset=utf-8";
      return "<Response></Response>";
    },
    {
      detail: {
        summary: "Twilio inbound webhook (marks activity)",
        tags: ["Tasks"],
      },
    },
  );
