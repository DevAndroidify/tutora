import { Body, Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ForApp, RequestId, type AuthUser } from '../../platform/http/request-context';
import { AppError } from '../../platform/errors/app-error';
import { LoginDto, RefreshDto, RegisterDto } from '../../modules/identity/auth/auth.dto';
import { AuthService, type AuthResult } from '../../modules/identity/auth/auth.service';
import type { IssuedTokens } from '../../modules/identity/auth/token.service';
import { BiddingModule } from '../../modules/bidding/bidding.module';
import { ModerationModule } from '../../modules/moderation/moderation.module';
import { NotificationsModule } from '../../modules/notifications/notifications.service';
import { RequestsModule } from '../../modules/requests/requests.module';
import { memberSharedControllers } from '../common/member-shared';
import { StudentRequestsController } from './requests.controller';
import { StudentBookingController } from './booking.controller';
import { groupControllers } from '../common/group-routes';
import { GroupBookingModule } from '../../modules/group-booking/group-booking.service';

import { replayControllers } from '../common/replay-routes';
import { ReplayModule } from '../../modules/replay/replay.service';
import { LowBandwidthModule } from '../../modules/lowbandwidth/lowbandwidth.service';
import { PoolingModule } from '../../modules/pooling/pooling.service';

import { sessionControllers } from '../common/session-routes';
import { LiveModule } from '../../modules/live/live-sessions.service';
import { MasteryModule } from '../../modules/mastery/mastery.service';
import { RecordingModule } from '../../modules/recording/recording.service';
import { SettlementModule } from '../../modules/settlement/settlement.service';

import { PaymentsModule } from '../../modules/payments/payments.module';
import { SessionsModule } from '../../modules/sessions/sessions.module';
import { IdentityModule } from '../../modules/identity/identity.module';
import { toUserView, UsersService, type UserView } from '../../modules/identity/users.service';
import { LoginRoute, LogoutRoute, RefreshRoute, RegisterRoute } from '../common/auth-routes';

const APP = 'student' as const;

@ApiTags('student: auth')
@ForApp(APP)
@Controller('student/auth')
export class StudentAuthController {
  constructor(private readonly auth: AuthService) {}

  @RegisterRoute()
  register(@Body() dto: RegisterDto): Promise<AuthResult> {
    return this.auth.register(APP, dto);
  }

  @LoginRoute()
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.auth.login(APP, dto.email, dto.password);
  }

  @RefreshRoute()
  refresh(@Body() dto: RefreshDto, @RequestId() requestId: string | null): Promise<IssuedTokens> {
    return this.auth.refresh(APP, dto.refreshToken, requestId);
  }

  @LogoutRoute()
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(APP, dto.refreshToken);
  }
}

@ApiTags('student: account')
@ApiBearerAuth()
@ForApp(APP)
@Controller('student')
export class StudentMeController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'The signed-in learner.' })
  async me(@CurrentUser() user: AuthUser): Promise<UserView> {
    const row = await this.users.findById(user.id);
    if (!row) throw AppError.unauthorized('UNAUTHENTICATED', 'Sign in to continue.');
    return toUserView(row);
  }
}

/**
 * Student app API (/student/*): learning requests, bids on them, reports, notifications.
 * Bookings and sessions are added in later parts.
 */
@Module({
  imports: [
    IdentityModule,
    ModerationModule,
    NotificationsModule,
    RequestsModule,
    BiddingModule,
    SessionsModule,
    PaymentsModule,
    LiveModule,
    MasteryModule,
    RecordingModule,
    SettlementModule,
    ReplayModule,
    LowBandwidthModule,
    PoolingModule,
    GroupBookingModule,
  ],
  controllers: [
    StudentAuthController,
    StudentMeController,
    StudentRequestsController,
    StudentBookingController,
    ...sessionControllers('student'),
    ...memberSharedControllers('student', 'REQUEST_ATTACHMENT'),
    ...replayControllers('student'),
    ...groupControllers('student'),
  ],
})
export class StudentAppModule {}
