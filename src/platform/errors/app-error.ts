import { HttpStatus } from '@nestjs/common';

export type ErrorDetails = Record<string, unknown>;

/**
 * Application error with a stable machine-readable code.
 * The global filter turns it into `{ error: { code, message, details, requestId } }`.
 */
export class AppError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError(HttpStatus.BAD_REQUEST, code, message, details);
  }

  static unauthorized(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError(HttpStatus.UNAUTHORIZED, code, message, details);
  }

  /** Ownership or role failure. */
  static forbidden(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError(HttpStatus.FORBIDDEN, code, message, details);
  }

  static notFound(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError(HttpStatus.NOT_FOUND, code, message, details);
  }

  /** Invalid state change or uniqueness conflict. */
  static conflict(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError(HttpStatus.CONFLICT, code, message, details);
  }

  static tooManyRequests(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError(HttpStatus.TOO_MANY_REQUESTS, code, message, details);
  }
}
