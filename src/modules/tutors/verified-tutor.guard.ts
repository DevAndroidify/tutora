import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppError } from '../../platform/errors/app-error';
import type { AppRequest } from '../../platform/http/request-context';
import { TutorsService } from './tutors.service';

/**
 * Tutor-app routes that need an approved tutor profile (e.g. bidding in Part 5).
 * Use with `@UseGuards(VerifiedTutorGuard)`. Per-skill approval is checked with
 * `TutorsService.canTeach(userId, skillId)` where the skill is known.
 */
@Injectable()
export class VerifiedTutorGuard implements CanActivate {
  constructor(private readonly tutors: TutorsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const user = ctx.switchToHttp().getRequest<AppRequest>().user;
    if (!user) {
      throw AppError.unauthorized('UNAUTHENTICATED', 'Sign in to continue.');
    }
    if (user.app !== 'tutor') {
      throw AppError.forbidden('WRONG_APP', 'This action is only available in the tutor app.');
    }
    if (!(await this.tutors.isVerified(user.id))) {
      throw AppError.forbidden(
        'TUTOR_NOT_VERIFIED',
        'Your tutor profile must be verified before you can do this.',
      );
    }
    return true;
  }
}
