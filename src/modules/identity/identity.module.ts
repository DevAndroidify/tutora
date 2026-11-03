import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth/auth.service';
import { AccessTokenGuard, StaffRolesGuard } from './auth/guards';
import { PasswordService } from './auth/password.service';
import { TokenService } from './auth/token.service';
import { IdentitySeeder } from './identity.seeder';
import { UsersService } from './users.service';

/**
 * Accounts, sign-in and access control. Owns `users` and `refresh_tokens`.
 * Has no controllers: each client app (src/apps/*) exposes its own auth routes.
 * Registers the global AccessTokenGuard and StaffRolesGuard (in that order).
 */
@Module({
  imports: [JwtModule.register({})],
  providers: [
    UsersService,
    PasswordService,
    TokenService,
    AuthService,
    IdentitySeeder,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: StaffRolesGuard },
  ],
  exports: [UsersService, AuthService, PasswordService, TokenService, IdentitySeeder],
})
export class IdentityModule {}
