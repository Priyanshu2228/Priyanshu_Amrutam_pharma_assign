import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError, PgCodes, pgCode } from '../lib/errors';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.id,
    },
  });
};

/**
 * Single place that turns exceptions into the API error envelope:
 * `{ error: { code, message, details?, requestId } }`. Internal details never leak on 5xx.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong';
    let details: unknown;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      message = 'Request validation failed';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'MALFORMED_JSON';
      message = 'Request body is not valid JSON';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body is too large';
    } else {
      const pg = pgCode(err);
      if (pg === PgCodes.UNIQUE_VIOLATION || pg === PgCodes.EXCLUSION_VIOLATION) {
        status = 409;
        code = 'CONFLICT';
        message = 'The request conflicts with the current state of the resource';
      } else if (pg === PgCodes.FOREIGN_KEY_VIOLATION) {
        status = 422;
        code = 'INVALID_REFERENCE';
        message = 'A referenced resource does not exist';
      }
    }

    if (status >= 500) logger.error({ err, requestId: req.id }, 'unhandled error');
    else logger.debug({ code, status }, 'request rejected');

    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
  };
}
