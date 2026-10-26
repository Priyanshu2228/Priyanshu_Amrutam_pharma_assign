import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { trace } from '@opentelemetry/api';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import type { AppContainer } from './container';
import { buildMiddleware } from './middleware';
import { createErrorHandler, notFoundHandler } from './middleware/error-handler';
import { adminRouter } from './modules/admin/admin.routes';
import { authRouter } from './modules/auth/auth.routes';
import { consultationsRouter } from './modules/consultations/consultations.routes';
import { doctorsRouter } from './modules/doctors/doctors.routes';
import { paymentsRouter } from './modules/payments/payments.routes';
import { prescriptionsRouter } from './modules/prescriptions/prescriptions.routes';
import { usersRouter } from './modules/users/users.routes';
import { requestContext } from './telemetry/context';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export interface AppState {
  /** Flipped to false on SIGTERM so the load balancer drains this instance first. */
  ready: boolean;
}

export function createApp(container: AppContainer, state: AppState = { ready: true }): Express {
  const c = container.cradle;
  const { config, logger, metrics } = c;
  const app = express();
  const mw = buildMiddleware(c);

  app.disable('x-powered-by');
  // Behind exactly one proxy hop (the ALB); makes req.ip the real client for rate limiting.
  app.set('trust proxy', 1);

  // Request id + async context for logs, traces and audit rows.
  const contextMiddleware: RequestHandler = (req, res, next) => {
    const incoming = req.header('X-Request-Id');
    req.id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    requestContext.run({ requestId: req.id, ip: req.ip, userAgent: req.header('user-agent') }, next);
  };
  app.use(contextMiddleware);

  // RED metrics keyed by the route template (not the raw URL) to keep cardinality bounded.
  // The same template names the HTTP server span (the express instrumentation cannot
  // resolve routes on Express 5, which would leave spans named just "POST").
  app.use((req, res, next) => {
    const end = metrics.httpRequestDuration.startTimer();
    const routeOf = () => {
      if (!req.route?.path) return 'unmatched';
      // Express resets req.baseUrl once the router exits (e.g. in the error handler), so
      // prefer the mount path recorded when the module router was entered.
      const base = (res.locals.routeBase as string | undefined) ?? req.baseUrl;
      return req.route.path === '/' && base ? base : `${base}${req.route.path}`;
    };
    const span = trace.getActiveSpan();
    if (span) {
      // The http instrumentation ends the span on 'finish', so name it when headers go out.
      const writeHead = res.writeHead;
      res.writeHead = ((...args: Parameters<typeof writeHead>) => {
        const route = routeOf();
        span.updateName(`${req.method} ${route}`);
        span.setAttribute('http.route', route);
        return writeHead.apply(res, args);
      }) as typeof res.writeHead;
    }
    res.on('finish', () => {
      end({ method: req.method, route: routeOf(), status_code: String(res.statusCode) });
    });
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => ['/healthz', '/readyz', '/metrics'].includes(req.url ?? '') },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : false,
      credentials: false,
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After', 'RateLimit-Remaining'],
    }),
  );
  app.use(
    express.json({
      limit: '100kb',
      // Keep the exact bytes for webhook HMAC verification.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );

  // --- operational endpoints (no auth, not rate limited)
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    if (!state.ready) {
      res.status(503).json({ status: 'draining' });
      return;
    }
    const checks = await Promise.allSettled([c.db.ping(), c.redis.ping()]);
    const [db, redis] = checks.map((r) => (r.status === 'fulfilled' ? 'ok' : 'down'));
    const ok = db === 'ok' && redis === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks: { db, redis } });
  });
  app.get('/metrics', async (req, res) => {
    if (config.metricsToken && req.header('authorization') !== `Bearer ${config.metricsToken}`) {
      res.status(401).end();
      return;
    }
    res.setHeader('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  const specPath = path.join(__dirname, '..', 'openapi', 'openapi.yaml');
  const spec = YAML.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  if (!config.isProduction) {
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
  }

  // --- API v1
  const v1 = express.Router();
  v1.use(mw.limit.global);
  const mount = (prefix: string, router: express.Router) =>
    v1.use(
      prefix,
      (req, res, next) => {
        res.locals.routeBase = req.baseUrl;
        next();
      },
      router,
    );
  mount('/auth', authRouter(c, mw));
  mount('/users', usersRouter(c, mw));
  mount('/doctors', doctorsRouter(c, mw));
  mount('/consultations', consultationsRouter(c, mw));
  mount('/prescriptions', prescriptionsRouter(c, mw));
  mount('/payments', paymentsRouter(c, mw));
  mount('/admin', adminRouter(c, mw));
  app.use('/v1', v1);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
