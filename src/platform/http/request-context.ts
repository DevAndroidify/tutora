import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export type ClientAppName = 'student' | 'tutor' | 'admin';

/** The authenticated caller attached to the request by the access-token guard. */
export interface AuthUser {
  id: string;
  email: string;
  /** Which app the token was issued to. Always equals the app of the route being called. */
  app: ClientAppName;
  accountType: 'MEMBER' | 'STAFF';
  staffRole: 'ADMIN' | 'MODERATOR' | null;
}

export type AppRequest = Request & { id?: string; user?: AuthUser };

export const CLIENT_APP_KEY = 'route:clientApp';

/**
 * Marks every route in a controller as belonging to one client app.
 * Non-public routes require an access token issued to that same app.
 */
export const ForApp = (app: ClientAppName): ClassDecorator => SetMetadata(CLIENT_APP_KEY, app);

/** Injects the authenticated user. Only use on routes that are not @Public(). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.user) {
    throw new Error('CurrentUser used on a route without authentication');
  }
  return req.user;
});

/** Injects the request id (`req_...`) for logs and audit entries. */
export const RequestId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | null => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    return typeof req.id === 'string' ? req.id : null;
  },
);

/** Shape used for audit entries: who acted, and in what capacity. */
export function auditActor(user: AuthUser): { id: string; role: string } {
  return { id: user.id, role: user.staffRole ?? `MEMBER:${user.app}` };
}
