import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../platform/config/app-config';
import { PasswordService } from './auth/password.service';
import { UsersService } from './users.service';

/** Creates the first staff ADMIN from ADMIN_EMAIL / ADMIN_PASSWORD. Safe to run repeatedly. */
@Injectable()
export class IdentitySeeder {
  private readonly logger = new Logger(IdentitySeeder.name);

  constructor(
    private readonly config: AppConfig,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
  ) {}

  async seedAdmin(): Promise<'created' | 'exists' | 'skipped'> {
    const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULL_NAME } = this.config.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      this.logger.warn('ADMIN_EMAIL or ADMIN_PASSWORD not set; skipping admin seed.');
      return 'skipped';
    }
    const existing = await this.users.findByEmail(ADMIN_EMAIL);
    if (existing) {
      if (existing.accountType !== 'STAFF' || existing.staffRole !== 'ADMIN') {
        throw new Error(
          `${ADMIN_EMAIL} already exists as a non-admin account; refusing to promote it.`,
        );
      }
      return 'exists';
    }
    await this.users.createStaff({
      email: ADMIN_EMAIL,
      passwordHash: await this.passwords.hash(ADMIN_PASSWORD),
      fullName: ADMIN_FULL_NAME,
      staffRole: 'ADMIN',
    });
    this.logger.log(`Created admin ${ADMIN_EMAIL}`);
    return 'created';
  }
}
