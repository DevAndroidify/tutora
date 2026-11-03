import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppError } from './app-error';

function flatten(errors: ValidationError[], parent = ''): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const err of errors) {
    const path = parent ? `${parent}.${err.property}` : err.property;
    if (err.constraints) {
      out[path] = Object.values(err.constraints);
    }
    if (err.children?.length) {
      Object.assign(out, flatten(err.children, path));
    }
  }
  return out;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      AppError.badRequest('VALIDATION_FAILED', 'Some fields are invalid.', {
        fields: flatten(errors),
      }),
  });
}
