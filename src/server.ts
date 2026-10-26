import { shutdownTracing } from './telemetry/tracing';
import { createApp, type AppState } from './app';
import { buildContainer } from './container';

async function main() {
  const container = buildContainer();
  const { config, logger } = container.cradle;
  const state: AppState = { ready: true };
  const app = createApp(container, state);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'amrutam api listening');
  });
  // Must exceed the ALB idle timeout so the LB, not Node, closes idle keep-alive sockets.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining traffic');
    state.ready = false;
    // Give the load balancer time to observe the failing readiness probe.
    await new Promise((r) => setTimeout(r, config.isProduction ? 10_000 : 0));
    server.close(async (err) => {
      if (err) logger.error({ err }, 'error closing http server');
      await container.dispose();
      await shutdownTracing();
      logger.info('shutdown complete');
      process.exit(err ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('failed to start', err);
  process.exit(1);
});
