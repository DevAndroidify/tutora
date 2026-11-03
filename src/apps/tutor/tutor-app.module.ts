import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ForApp, RequestId, type AuthUser } from '../../platform/http/request-context';
import { AppError } from '../../platform/errors/app-error';
import { CatalogModule } from '../../modules/catalog/catalog.module';
import { CatalogService, type SuggestionView } from '../../modules/catalog/catalog.service';
import { LoginDto, RefreshDto, RegisterDto } from '../../modules/identity/auth/auth.dto';
import { AuthService, type AuthResult } from '../../modules/identity/auth/auth.service';
import type { IssuedTokens } from '../../modules/identity/auth/token.service';
import { BiddingModule } from '../../modules/bidding/bidding.module';
import { ModerationModule } from '../../modules/moderation/moderation.module';
import { NotificationsModule } from '../../modules/notifications/notifications.service';
import { RequestsModule } from '../../modules/requests/requests.module';
import { memberSharedControllers } from '../common/member-shared';
import { TutorMarketplaceController } from './marketplace.controller';
import { groupControllers } from '../common/group-routes';
import { GroupBookingModule } from '../../modules/group-booking/group-booking.service';

import { replayControllers } from '../common/replay-routes';
import { ReplayModule } from '../../modules/replay/replay.service';
import { LowBandwidthModule } from '../../modules/lowbandwidth/lowbandwidth.service';

import { sessionControllers } from '../common/session-routes';
import { LiveModule } from '../../modules/live/live-sessions.service';
import { RecordingModule } from '../../modules/recording/recording.service';
import { SettlementModule } from '../../modules/settlement/settlement.service';

import { SessionsModule } from '../../modules/sessions/sessions.module';
import { IdentityModule } from '../../modules/identity/identity.module';
import { toUserView, UsersService, type UserView } from '../../modules/identity/users.service';
import { TutorsModule } from '../../modules/tutors/tutors.module';
import { TutorsService, type TutorProfileView } from '../../modules/tutors/tutors.service';
import { LoginRoute, LogoutRoute, RefreshRoute, RegisterRoute } from '../common/auth-routes';
import { SuggestSkillDto, UpsertTutorProfileDto, UpsertTutorSkillDto } from './tutor.dto';

const APP = 'tutor' as const;

@ApiTags('tutor: auth')
@ForApp(APP)
@Controller('tutor/auth')
export class TutorAuthController {
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

@ApiTags('tutor: account')
@ApiBearerAuth()
@ForApp(APP)
@Controller('tutor')
export class TutorAccountController {
  constructor(
    private readonly users: UsersService,
    private readonly tutors: TutorsService,
    private readonly catalog: CatalogService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'The signed-in member and whether they have a tutor profile yet.' })
  async me(
    @CurrentUser() user: AuthUser,
  ): Promise<UserView & { tutorProfile: { verificationStatus: string; badge: string } | null }> {
    const row = await this.users.findById(user.id);
    if (!row) throw AppError.unauthorized('UNAUTHENTICATED', 'Sign in to continue.');
    const profile = await this.tutors.findProfile(user.id);
    return {
      ...toUserView(row),
      tutorProfile: profile
        ? { verificationStatus: profile.verificationStatus, badge: profile.badge }
        : null,
    };
  }

  @Get('profile')
  @ApiOperation({ summary: 'Your tutor profile with every skill claim and its review status.' })
  getProfile(@CurrentUser() user: AuthUser): Promise<TutorProfileView> {
    return this.tutors.getOwnProfile(user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Create (become a tutor) or update your tutor profile.' })
  upsertProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertTutorProfileDto,
  ): Promise<TutorProfileView> {
    return this.tutors.upsertProfile(user, dto);
  }

  @Post('profile/verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit your profile for staff verification.' })
  submit(@CurrentUser() user: AuthUser): Promise<TutorProfileView> {
    return this.tutors.submitForVerification(user);
  }

  @Put('skills/:skillId')
  @ApiOperation({
    summary: 'List a skill you teach, with evidence. Each skill is reviewed by staff.',
  })
  upsertSkill(
    @CurrentUser() user: AuthUser,
    @Param('skillId', new ParseUUIDPipe()) skillId: string,
    @Body() dto: UpsertTutorSkillDto,
  ): Promise<TutorProfileView> {
    return this.tutors.upsertSkill(user, skillId, dto);
  }

  @Delete('skills/:skillId')
  @ApiOperation({ summary: 'Stop offering a skill.' })
  removeSkill(
    @CurrentUser() user: AuthUser,
    @Param('skillId', new ParseUUIDPipe()) skillId: string,
  ): Promise<TutorProfileView> {
    return this.tutors.removeSkill(user, skillId);
  }

  @Get('skill-suggestions')
  @ApiOperation({ summary: 'Skills you suggested for the catalog.' })
  listSuggestions(@CurrentUser() user: AuthUser): Promise<SuggestionView[]> {
    return this.catalog.listOwnSuggestions(user);
  }

  @Post('skill-suggestions')
  @ApiOperation({ summary: 'Suggest a skill that is missing from the catalog.' })
  suggest(@CurrentUser() user: AuthUser, @Body() dto: SuggestSkillDto): Promise<SuggestionView> {
    return this.catalog.suggestSkill(user, dto);
  }
}

/**
 * Tutor app API (/tutor/*). Bidding and session tools are added in later parts.
 */
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    TutorsModule,
    ModerationModule,
    NotificationsModule,
    RequestsModule,
    BiddingModule,
    SessionsModule,
    LiveModule,
    RecordingModule,
    SettlementModule,
    ReplayModule,
    LowBandwidthModule,
    GroupBookingModule,
  ],
  controllers: [
    TutorAuthController,
    TutorAccountController,
    TutorMarketplaceController,
    ...sessionControllers('tutor'),
    ...memberSharedControllers('tutor', 'BID_MEDIA'),
    ...replayControllers('tutor'),
    ...groupControllers('tutor'),
  ],
})
export class TutorAppModule {}
