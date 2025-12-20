import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { env } from './env';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

export const telemetryConfig = {
  serviceName: process.env.OTEL_SERVICE_NAME || 'infra-test-api',
  enabled: process.env.OTEL_ENABLED !== 'false',

  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
      }),
    ),
  ],

  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
    }),
    exportIntervalMillis: env.isDev ? 10000 : 60000,
  }),
};
