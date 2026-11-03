import { HttpCode, HttpStatus, Post, applyDecorators } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Public } from '../../platform/http/route-metadata';
import { RateLimit } from '../../platform/rate-limit/rate-limit';

/**
 * Shared decorators for each app's auth routes. Every app exposes
 * POST {app}/auth/login|refresh|logout; member apps also expose register.
 */
export const RegisterRoute = () =>
  applyDecorators(
    Public(),
    Post('register'),
    ApiOperation({
      summary:
        'Create a member account and sign in. The same account also works in the other member app.',
    }),
  );

export const LoginRoute = () =>
  applyDecorators(
    Public(),
    Post('login'),
    HttpCode(HttpStatus.OK),
    RateLimit('login'),
    ApiOperation({ summary: 'Sign in to this app. Rate-limited per IP and email.' }),
  );

export const RefreshRoute = () =>
  applyDecorators(
    Public(),
    Post('refresh'),
    HttpCode(HttpStatus.OK),
    ApiOperation({
      summary:
        "Exchange this app's refresh token for a new pair. Reusing an old token signs out that whole session.",
    }),
  );

export const LogoutRoute = () =>
  applyDecorators(
    Public(),
    Post('logout'),
    HttpCode(HttpStatus.NO_CONTENT),
    ApiOperation({ summary: 'Revoke the session that owns this refresh token.' }),
  );
