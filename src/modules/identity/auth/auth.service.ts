import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../platform/config/app-config';
import { AuditService } from '../../../platform/audit/audit.service';
import { InjectDb, type Database } from '../../../platform/database/database.module';
import { AppError } from '../../../platform/errors/app-error';
import type { ClientApp, MemberApp, UserRow } from '../identity.schema';
import { toUserView, UsersService, type UserView } from '../users.service';
import { PasswordService } from './password.service';
import { TokenService, type IssuedTokens } from './token.service';

export interface AuthResult extends IssuedTokens {
  user: UserView;
}

const INVALID_CREDENTIALS = () =>
  AppError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect.');

const INVALID_REFRESH = () =>
  AppError.unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired.');

/** Throws unless the account is active. Suspensions and bans come from moderation (Part 3). */
export function assertActive(user: UserRow): void {
  if (user.status === 'SUSPENDED') {
    throw AppError.forbidden('ACCOUNT_SUSPENDED', 'This account is suspended.');
  }
  if (user.status === 'BANNED') {
    throw AppError.forbidden('ACCOUNT_BANNED', 'This account has been banned.');
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Creates a member account and signs it in to the app it registered from.
   * The same account can later sign in to the other member app.
   */
  async register(
    app: MemberApp,
    input: { email: string; password: string; fullName: string },
  ): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(input.password);
    return this.db.transaction(async (tx) => {
      const user = await this.users.createMember({ ...input, passwordHash }, tx);
      const refresh = await this.tokens.issueRefreshToken(user.id, app, tx);
      return {
        user: toUserView(user),
        ...(await this.bundle(user.id, app, refresh.token, refresh.expiresAt)),
      };
    });
  }

  /**
   * Members may sign in to the student and tutor apps; staff only to the admin app.
   * Wrong-app attempts get the same error as a wrong password, so the admin app
   * doesn't reveal which emails are staff.
   */
  async login(app: ClientApp, email: string, password: string): Promise<AuthResult> {
    const user = await this.users.findByEmail(email);
    const ok = user
      ? await this.passwords.verify(user.passwordHash, password)
      : await this.passwords.verifyAgainstDummy(password);
    if (!user || !ok) throw INVALID_CREDENTIALS();

    const allowed = app === 'admin' ? user.accountType === 'STAFF' : user.accountType === 'MEMBER';
    if (!allowed) throw INVALID_CREDENTIALS();
    assertActive(user);

    const refresh = await this.tokens.issueRefreshToken(user.id, app);
    return {
      user: toUserView(user),
      ...(await this.bundle(user.id, app, refresh.token, refresh.expiresAt)),
    };
  }

  async refresh(
    app: ClientApp,
    refreshToken: string,
    requestId: string | null,
  ): Promise<IssuedTokens> {
    const outcome = await this.db.transaction((tx) => this.tokens.rotate(refreshToken, app, tx));

    switch (outcome.kind) {
      case 'invalid':
      case 'expired':
        throw INVALID_REFRESH();

      case 'reused': {
        // Someone presented a token that was already exchanged. Assume theft: kill the family.
        await this.db.transaction(async (tx) => {
          const revoked = await this.tokens.revokeFamily(outcome.familyId, 'REUSE_DETECTED', tx);
          await this.audit.record(
            {
              actor: null,
              action: 'auth.refresh_token_reuse_detected',
              entityType: 'user',
              entityId: outcome.userId,
              metadata: { app, familyId: outcome.familyId, revokedTokens: revoked },
              requestId,
            },
            tx,
          );
        });
        this.logger.warn(
          { userId: outcome.userId, app, requestId },
          'Refresh token reuse detected',
        );
        throw AppError.unauthorized(
          'REFRESH_TOKEN_REUSED',
          'This refresh token was already used. Please sign in again.',
        );
      }

      case 'rotated': {
        const user = await this.users.findById(outcome.userId);
        if (!user || user.status !== 'ACTIVE') {
          await this.tokens.revokeFamily(outcome.familyId, 'USER_INACTIVE');
          throw INVALID_REFRESH();
        }
        return this.bundle(user.id, app, outcome.newToken, outcome.expiresAt);
      }
    }
  }

  /** Revokes the sign-in (token family) in this app. Unknown tokens are ignored. */
  async logout(app: ClientApp, refreshToken: string): Promise<void> {
    const family = await this.tokens.findFamilyOf(refreshToken, app);
    if (family) {
      await this.tokens.revokeFamily(family.familyId, 'LOGOUT');
    }
  }

  private async bundle(
    userId: string,
    app: ClientApp,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<IssuedTokens> {
    return {
      accessToken: await this.tokens.signAccessToken(userId, app),
      accessTokenExpiresIn: this.config.auth.accessTtlSeconds,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      tokenType: 'Bearer',
    };
  }
}
