import { cors } from "@elysiajs/cors";
import { opentelemetry } from "@elysiajs/opentelemetry";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { env } from "@/config/env";
import { telemetryConfig } from "@/config/telemetry";
import { authController } from "@/modules/auth";
import { dbAdminController } from "@/modules/db-admin";
import { flowsController } from "@/modules/flows";
import { tasksController } from "@/modules/tasks";
import { usersController } from "@/modules/users";

export const app = new Elysia()
  .use(
    opentelemetry({
      serviceName: telemetryConfig.serviceName,
      spanProcessors: telemetryConfig.spanProcessors,
      metricReader: telemetryConfig.metricReader,
    }),
  )
  .use(cors())
  .use(
    swagger({
      documentation: {
        info: {
          title: "API Documentation",
          version: "1.0.0",
          description: "API built with Bun, Elysia and ScyllaDB",
        },
        tags: [
          { name: "Health", description: "Health check endpoints" },
          { name: "Auth", description: "Authentication endpoints" },
          { name: "Users", description: "User management endpoints" },
          {
            name: "Tasks",
            description: "Operator tasks and inactivity timers",
          },
          {
            name: "Flows",
            description: "Flow builder for Twilio Studio chatbots",
          },
          {
            name: "DB Admin",
            description: "Internal ScyllaDB admin panel",
          },
        ],
      },
      path: "/docs",
    }),
  )
  .get(
    "/health",
    () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
      environment: env.nodeEnv,
    }),
    {
      detail: {
        summary: "Health check",
        tags: ["Health"],
      },
    },
  )
  .use(authController)
  .use(usersController)
  .use(tasksController)
  .use(flowsController)
  .use(dbAdminController)
  .onError(({ code, error }) => {
    console.error(`Error [${code}]:`, error);

    if (code === "VALIDATION") {
      return {
        error: "Validation Error",
        message: "message" in error ? error.message : "Validation failed",
      };
    }

    const errorMessage = "message" in error ? error.message : "Unknown error";

    return {
      error: "Internal Server Error",
      message: env.isDev ? errorMessage : "Something went wrong",
    };
  });

export type App = typeof app;
