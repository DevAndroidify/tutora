/**
 * OpenTelemetry tracing. Imported first by api.main.ts and worker.main.ts so instrumentation
 * patches http, express, pg and ioredis before they load. Off unless OTEL_ENABLED=true.
 * Spans go to an OTLP/HTTP collector (OTEL_EXPORTER_OTLP_ENDPOINT, e.g. http://localhost:4318).
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { loadEnvFiles } from '../config/app-config';

loadEnvFiles();

let sdk: NodeSDK | undefined;

if (['true', '1'].includes(process.env.OTEL_ENABLED ?? '')) {
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(
    /\/$/,
    '',
  );
  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'tutora',
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });
  sdk.start();
  const stop = () => {
    void sdk?.shutdown();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

export const tracingEnabled = (): boolean => sdk !== undefined;
