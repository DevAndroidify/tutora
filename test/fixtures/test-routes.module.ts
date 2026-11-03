import { Body, Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsPositive, IsString, IsUUID } from 'class-validator';
import { AppError } from '../../src/platform/errors/app-error';
import { CurrentUser, ForApp, type AuthUser } from '../../src/platform/http/request-context';
import { Idempotent } from '../../src/platform/idempotency/idempotency.interceptor';
import { assertOwnership } from '../../src/modules/identity/auth/ownership';
import { TutorsModule } from '../../src/modules/tutors/tutors.module';
import { VerifiedTutorGuard } from '../../src/modules/tutors/verified-tutor.guard';

class FakeChargeDto {
  @IsInt()
  @IsPositive()
  amountPaise!: number;

  @IsString()
  note!: string;
}

class OwnedDto {
  @IsUUID()
  ownerId!: string;
}

/** Counts how many times handlers really ran, so tests can prove replays skip the handler. */
export const testRouteCalls = { charge: 0, failOnce: 0 };

/**
 * Test-only routes exercising reusable building blocks (idempotency, guards, ownership)
 * before real money or bidding endpoints exist.
 */
@ForApp('student')
@Controller('student/__test__')
class StudentTestRoutes {
  @Post('charges')
  @Idempotent()
  charge(@CurrentUser() user: AuthUser, @Body() dto: FakeChargeDto) {
    testRouteCalls.charge += 1;
    return { chargeNo: testRouteCalls.charge, userId: user.id, amountPaise: dto.amountPaise };
  }

  @Post('fail-once')
  @Idempotent()
  failOnce() {
    testRouteCalls.failOnce += 1;
    if (testRouteCalls.failOnce === 1) {
      throw AppError.conflict('TRANSIENT', 'First attempt fails.');
    }
    return { attempt: testRouteCalls.failOnce };
  }

  @Post('owned')
  owned(@CurrentUser() user: AuthUser, @Body() body: OwnedDto) {
    assertOwnership(user, body.ownerId, { allowStaff: true });
    return { ok: true };
  }
}

@ForApp('admin')
@Controller('admin/__test__')
class AdminTestRoutes {
  @Post('owned')
  owned(@CurrentUser() user: AuthUser, @Body() body: OwnedDto) {
    assertOwnership(user, body.ownerId, { allowStaff: true });
    return { ok: true };
  }
}

@ForApp('tutor')
@Controller('tutor/__test__')
class TutorTestRoutes {
  @Get('verified-only')
  @UseGuards(VerifiedTutorGuard)
  verifiedOnly(@CurrentUser() user: AuthUser) {
    return { ok: true, userId: user.id };
  }
}

@Module({
  imports: [TutorsModule],
  controllers: [StudentTestRoutes, AdminTestRoutes, TutorTestRoutes],
})
export class TestRoutesModule {}
