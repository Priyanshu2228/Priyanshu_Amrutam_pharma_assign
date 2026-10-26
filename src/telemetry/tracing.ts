/**
 * OpenTelemetry bootstrap. Must be the first import of every process entrypoint so the
 * auto-instrumentations can patch http, express, pg, ioredis and bullmq before they load.
 */
import 'dotenv/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

const enabled = ['true', '1'].includes(process.env.OTEL_ENABLED ?? '');

if (enabled) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'amrutam-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are noisy and carry no value for request latency analysis.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => ['/healthz', '/readyz', '/metrics'].includes(req.url ?? ''),
        },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
}
