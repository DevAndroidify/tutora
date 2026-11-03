import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../platform/errors/app-error';
import { IS_PUBLIC_KEY } from '../../../platform/http/route-metadata';
import {
  CLIENT_APP_KEY,
  type AppRequest,
  type AuthUser,
  type ClientAppName,
} from '../../../platform/http/request-context';
import type { StaffRole } from '../identity.schema';
import { UsersService } from '../users.service';
import { TokenService } from './token.service';

export const STAFF_ROLES_KEY = 'route:staffRoles';

/**
 * Restricts an admin-app route to the given staff roles. A wrong role returns 403 FORBIDDEN_ROLE.
 */
export const StaffRoles = (...roles: StaffRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(STAFF_ROLES_KEY, roles);

/**
 * Global guard. Every route needs a valid Bearer access token unless marked @Public().
 * The token's app (audience) must equal the route's app (@ForApp on the controller),
 * so a student-app token cannot call tutor or admin routes, and vice versa.
 * Also re-checks that the account still exists and is active.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true) return true;

    const routeApp = this.reflector.getAllAndOverride<ClientAppName | undefined>(
      CLIENT_APP_KEY,
      targets,
    );
    if (!routeApp) {
      // Programming error: every private route must declare its app.
      throw new Error(`Route ${ctx.getClass().name}.${ctx.getHandler().name} has no @ForApp()`);
    }

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match?.[1]) {
      throw AppError.unauthorized('UNAUTHENTICATED', 'Sign in to continue.');
    }

    const claims = await this.tokens.verifyAccessToken(match[1]);
    if (!claims) {
      throw AppError.unauthorized('INVALID_ACCESS_TOKEN', 'Access token is invalid or expired.');
    }
    if (claims.aud !== routeApp) {
      throw AppError.unauthorized(
        'TOKEN_APP_MISMATCH',
        `This token was issued to the ${claims.aud} app and cannot be used in the ${routeApp} app.`,
      );
    }

    const user = await this.users.findById(claims.sub);
    if (!user || user.status !== 'ACTIVE') {
      throw AppError.unauthorized('INVALID_ACCESS_TOKEN', 'Access token is invalid or expired.');
    }
    // Defence in depth: account type must still fit the app.
    const fits =
      routeApp === 'admin' ? user.accountType === 'STAFF' : user.accountType === 'MEMBER';
    if (!fits) {
      throw AppError.unauthorized('INVALID_ACCESS_TOKEN', 'Access token is invalid or expired.');
    }

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      app: routeApp,
      accountType: user.accountType,
      staffRole: user.staffRole,
    };
    req.user = authUser;
    return true;
  }
}

/** Global guard enforcing @StaffRoles(). Runs after AccessTokenGuard. */
@Injectable()
export class StaffRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(STAFF_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const user = ctx.switchToHttp().getRequest<AppRequest>().user;
    if (
      !user ||
      user.accountType !== 'STAFF' ||
      !user.staffRole ||
      !roles.includes(user.staffRole)
    ) {
      throw AppError.forbidden('FORBIDDEN_ROLE', 'Your role cannot perform this action.', {
        requiredRoles: roles,
      });
    }
    return true;
  }
}
