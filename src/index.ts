import { env } from "@/config/env";
import { connectDatabase, disconnectDatabase, runMigrations } from "@/database";
import {
  startTasksAutoProcessor,
  stopTasksAutoProcessor,
} from "@/modules/tasks/tasks.worker";
import { createLogger } from "@/shared/utils/logger";
import { app } from "./app";

const logger = createLogger("Bootstrap");

async function bootstrap() {
  try {
    await runMigrations();
    await connectDatabase();

    startTasksAutoProcessor();

    app.listen(env.port);

    logger.log(`Application successfully started`);
    logger.log(`Listening on http://localhost:${env.port}`, "HttpServer");
    logger.log(`Swagger docs on http://localhost:${env.port}/docs`, "Swagger");
  } catch (error) {
    logger.error(
      "Failed to start application",
      error instanceof Error ? error.stack : undefined,
    );
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  logger.warn("Received SIGINT signal, shutting down gracefully...");
  stopTasksAutoProcessor();
  await disconnectDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.warn("Received SIGTERM signal, shutting down gracefully...");
  stopTasksAutoProcessor();
  await disconnectDatabase();
  process.exit(0);
});

bootstrap();
