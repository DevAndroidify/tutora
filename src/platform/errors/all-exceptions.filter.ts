import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, type ErrorDetails } from './app-error';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: ErrorDetails;
    requestId: string | null;
  };
}

const STATUS_CODES: Partial<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export function requestIdOf(req: Request): string | null {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * Turns every thrown error into the standard error JSON shape.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const { status, code, message, details } = this.describe(exception);

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId: requestIdOf(req) },
        exception instanceof Error ? exception.message : 'Unhandled error',
      );
    }

    const body: ErrorBody = {
      error: { code, message, details, requestId: requestIdOf(req) },
    };
    if (!res.headersSent) {
      res.status(status).json(body);
    }
  }

  private describe(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details: ErrorDetails;
  } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      let message = exception.message;
      if (typeof response === 'object' && response !== null && 'message' in response) {
        const m = (response as { message: unknown }).message;
        message = Array.isArray(m) ? m.join('; ') : String(m);
      }
      return {
        status,
        code: STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
        message,
        details: {},
      };
    }

    // Body-parser errors (malformed JSON, payload too large) carry `status` and `type`.
    if (isBodyParserError(exception)) {
      const status = exception.status;
      return {
        status,
        code: exception.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_REQUEST',
        message: status === 413 ? 'Request body is too large.' : 'Request body is not valid JSON.',
        details: {},
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      details: {},
    };
  }
}

function isBodyParserError(e: unknown): e is { status: number; type: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { status?: unknown }).status === 'number' &&
    typeof (e as { type?: unknown }).type === 'string' &&
    (e as { status: number }).status >= 400 &&
    (e as { status: number }).status < 500
  );
}
