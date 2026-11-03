import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { AppConfig } from '../../../platform/config/app-config';
import { Clock } from '../../../platform/clock/clock';
import {
  InjectDb,
  type Database,
  type DbExecutor,
} from '../../../platform/database/database.module';
import { CLIENT_APPS, refreshTokens, type ClientApp } from '../identity.schema';

export const TOKEN_ISSUER = 'tutora';

export interface AccessTokenClaims {
  sub: string;
  /** Audience = the client app the token was issued to. */
  aud: ClientApp;
  typ: 'access';
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: 'Bearer';
}

export type RotateOutcome =
  | { kind: 'rotated'; userId: string; familyId: string; newToken: string; expiresAt: Date }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'reused'; userId: string; familyId: string };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    @InjectDb() private readonly db: Database,
  ) {}

  async signAccessToken(userId: string, app: ClientApp): Promise<string> {
    const nowSec = Math.floor(this.clock.nowMs() / 1000);
    return this.jwt.signAsync(
      {
        sub: userId,
        aud: app,
        typ: 'access',
        iss: TOKEN_ISSUER,
        iat: nowSec,
        exp: nowSec + this.config.auth.accessTtlSeconds,
      },
      { secret: this.config.auth.accessSecret, algorithm: 'HS256' },
    );
  }

  /** Returns claims, or null if the token is missing, forged, expired or not an access token. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.auth.accessSecret,
        algorithms: ['HS256'],
        issuer: TOKEN_ISSUER,
        clockTimestamp: Math.floor(this.clock.nowMs() / 1000),
      });
      const validAud = (CLIENT_APPS as readonly string[]).includes(claims.aud);
      return claims.typ === 'access' && typeof claims.sub === 'string' && validAud ? claims : null;
    } catch {
      return null;
    }
  }

  private newOpaqueToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private refreshExpiry(): Date {
    return new Date(this.clock.nowMs() + this.config.auth.refreshTtlDays * 86_400_000);
  }

  /** Starts a new token family for one sign-in to one app. */
  async issueRefreshToken(
    userId: string,
    app: ClientApp,
    tx: DbExecutor = this.db,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = this.newOpaqueToken();
    const expiresAt = this.refreshExpiry();
    await tx.insert(refreshTokens).values({
      userId,
      app,
      familyId: randomUUID(),
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: this.clock.now(),
    });
    return { token, expiresAt };
  }

  /**
   * Exchanges a refresh token for a new one in the same family.
   * A token from another app is treated as invalid.
   * A token that was already rotated or revoked counts as reuse: the caller must revoke the family.
   */
  async rotate(token: string, app: ClientApp, tx: DbExecutor): Promise<RotateOutcome> {
    const [row] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(token)))
      .for('update');

    if (!row || row.app !== app) return { kind: 'invalid' };
    if (row.rotatedAt || row.revokedAt) {
      return { kind: 'reused', userId: row.userId, familyId: row.familyId };
    }
    const now = this.clock.now();
    if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

    const newToken = this.newOpaqueToken();
    const expiresAt = this.refreshExpiry();
    const [created] = await tx
      .insert(refreshTokens)
      .values({
        userId: row.userId,
        app,
        familyId: row.familyId,
        tokenHash: hashToken(newToken),
        expiresAt,
        createdAt: now,
      })
      .returning({ id: refreshTokens.id });
    await tx
      .update(refreshTokens)
      .set({ rotatedAt: now, replacedById: created!.id })
      .where(eq(refreshTokens.id, row.id));

    return { kind: 'rotated', userId: row.userId, familyId: row.familyId, newToken, expiresAt };
  }

  async revokeFamily(familyId: string, reason: string, tx: DbExecutor = this.db): Promise<number> {
    const revoked = await tx
      .update(refreshTokens)
      .set({ revokedAt: this.clock.now(), revokedReason: reason })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return revoked.length;
  }

  /** Revokes every session of a user in every app. Used when an account is suspended (Part 3). */
  async revokeAllForUser(
    userId: string,
    reason: string,
    tx: DbExecutor = this.db,
  ): Promise<number> {
    const revoked = await tx
      .update(refreshTokens)
      .set({ revokedAt: this.clock.now(), revokedReason: reason })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return revoked.length;
  }

  async findFamilyOf(
    token: string,
    app: ClientApp,
  ): Promise<{ familyId: string; userId: string } | null> {
    const [row] = await this.db
      .select({ familyId: refreshTokens.familyId, userId: refreshTokens.userId })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hashToken(token)), eq(refreshTokens.app, app)));
    return row ?? null;
  }
}
