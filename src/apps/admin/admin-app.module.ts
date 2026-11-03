import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ForApp, RequestId, type AuthUser } from '../../platform/http/request-context';
import { AppError } from '../../platform/errors/app-error';
import { CatalogModule } from '../../modules/catalog/catalog.module';
import {
  CatalogService,
  type CategoryView,
  type Page,
  type SkillView,
  type SuggestionView,
  type TopicView,
} from '../../modules/catalog/catalog.service';
import { LoginDto, RefreshDto } from '../../modules/identity/auth/auth.dto';
import { AuthService, type AuthResult } from '../../modules/identity/auth/auth.service';
import { StaffRoles } from '../../modules/identity/auth/guards';
import type { IssuedTokens } from '../../modules/identity/auth/token.service';
import { IdentityModule } from '../../modules/identity/identity.module';
import { ModerationModule } from '../../modules/moderation/moderation.module';
import { AdminModerationController } from './moderation.controller';
import { AdminPaymentsController } from './payments.controller';
import { AdminSettlementController } from './settlement.controller';
import { LowBandwidthModule } from '../../modules/lowbandwidth/lowbandwidth.service';
import { LiveModule } from '../../modules/live/live-sessions.service';
import { RecordingModule } from '../../modules/recording/recording.service';
import { SettlementModule } from '../../modules/settlement/settlement.service';
import { PaymentsModule } from '../../modules/payments/payments.module';
import { toUserView, UsersService, type UserView } from '../../modules/identity/users.service';
import { TutorsModule } from '../../modules/tutors/tutors.module';
import {
  TutorsService,
  type ProfileReviewItem,
  type SkillReviewItem,
  type TutorProfileView,
} from '../../modules/tutors/tutors.service';
import { LoginRoute, LogoutRoute, RefreshRoute } from '../common/auth-routes';
import {
  AdminSkillQuery,
  ApproveSuggestionDto,
  ApproveTutorDto,
  CreateCategoryDto,
  CreateSkillDto,
  CreateTopicDto,
  ProfileReviewQuery,
  RejectDto,
  SkillReviewQuery,
  SuggestionQuery,
  UpdateCategoryDto,
  UpdateSkillDto,
} from './admin.dto';

const APP = 'admin' as const;

/** Staff sign in here only. There is no public registration for the admin app. */
@ApiTags('admin: auth')
@ForApp(APP)
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AuthService) {}

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

@ApiTags('admin: account')
@ApiBearerAuth()
@ForApp(APP)
@Controller('admin')
export class AdminMeController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'The signed-in staff member.' })
  async me(@CurrentUser() user: AuthUser): Promise<UserView> {
    const row = await this.users.findById(user.id);
    if (!row) throw AppError.unauthorized('UNAUTHENTICATED', 'Sign in to continue.');
    return toUserView(row);
  }
}

@ApiTags('admin: tutor verification')
@ApiBearerAuth()
@ForApp(APP)
@StaffRoles('ADMIN')
@Controller('admin/tutors')
export class AdminTutorsController {
  constructor(private readonly tutors: TutorsService) {}

  @Get('profile-reviews')
  @ApiOperation({ summary: 'Tutor profiles by verification status (PENDING by default).' })
  profileReviews(@Query() q: ProfileReviewQuery): Promise<ProfileReviewItem[]> {
    return this.tutors.listProfileReviews(q.status ?? 'PENDING');
  }

  @Get('skill-reviews')
  @ApiOperation({ summary: 'Skill claims by status (PENDING by default), with evidence links.' })
  skillReviews(@Query() q: SkillReviewQuery): Promise<SkillReviewItem[]> {
    return this.tutors.listSkillReviews(q.status ?? 'PENDING');
  }

  @Post(':userId/verification/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending tutor profile. Audited.' })
  approve(
    @CurrentUser() staff: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: ApproveTutorDto,
    @RequestId() requestId: string | null,
  ): Promise<TutorProfileView> {
    return this.tutors.approveProfile(staff, userId, dto, requestId);
  }

  @Post(':userId/verification/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending tutor profile with a reason. Audited.' })
  reject(
    @CurrentUser() staff: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: RejectDto,
    @RequestId() requestId: string | null,
  ): Promise<TutorProfileView> {
    return this.tutors.rejectProfile(staff, userId, dto.reason, requestId);
  }

  @Post(':userId/skills/:skillId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve one skill claim. Audited.' })
  approveSkill(
    @CurrentUser() staff: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('skillId', new ParseUUIDPipe()) skillId: string,
    @RequestId() requestId: string | null,
  ): Promise<TutorProfileView> {
    return this.tutors.decideSkill(staff, userId, skillId, { approve: true }, requestId);
  }

  @Post(':userId/skills/:skillId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject one skill claim with a reason. Audited.' })
  rejectSkill(
    @CurrentUser() staff: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('skillId', new ParseUUIDPipe()) skillId: string,
    @Body() dto: RejectDto,
    @RequestId() requestId: string | null,
  ): Promise<TutorProfileView> {
    return this.tutors.decideSkill(
      staff,
      userId,
      skillId,
      { approve: false, reason: dto.reason },
      requestId,
    );
  }
}

@ApiTags('admin: catalog')
@ApiBearerAuth()
@ForApp(APP)
@StaffRoles('ADMIN')
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @ApiOperation({ summary: 'All categories, including inactive ones.' })
  categories(): Promise<CategoryView[]> {
    return this.catalog.listAllCategories();
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create a category or sub-category. Audited.' })
  createCategory(
    @CurrentUser() staff: AuthUser,
    @Body() dto: CreateCategoryDto,
    @RequestId() requestId: string | null,
  ): Promise<CategoryView> {
    return this.catalog.createCategory(staff, dto, requestId);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Rename, reorder or deactivate a category. Audited.' })
  updateCategory(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCategoryDto,
    @RequestId() requestId: string | null,
  ): Promise<CategoryView> {
    return this.catalog.updateCategory(staff, id, dto, requestId);
  }

  @Get('skills')
  @ApiOperation({ summary: 'Search all skills, including inactive ones.' })
  skills(@Query() q: AdminSkillQuery): Promise<Page<SkillView>> {
    return this.catalog.searchSkills({ ...q, includeInactive: true });
  }

  @Post('skills')
  @ApiOperation({ summary: 'Add a skill. Audited.' })
  createSkill(
    @CurrentUser() staff: AuthUser,
    @Body() dto: CreateSkillDto,
    @RequestId() requestId: string | null,
  ): Promise<SkillView> {
    return this.catalog.createSkill(staff, dto, requestId);
  }

  @Patch('skills/:id')
  @ApiOperation({ summary: 'Edit, move or deactivate a skill. Audited.' })
  updateSkill(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSkillDto,
    @RequestId() requestId: string | null,
  ): Promise<SkillView> {
    return this.catalog.updateSkill(staff, id, dto, requestId);
  }

  @Post('skills/:id/topics')
  @ApiOperation({ summary: 'Add a topic to a skill. Audited.' })
  createTopic(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateTopicDto,
    @RequestId() requestId: string | null,
  ): Promise<TopicView> {
    return this.catalog.createTopic(staff, id, dto, requestId);
  }

  @Get('skill-suggestions')
  @ApiOperation({ summary: 'Skills suggested by tutors (PENDING by default).' })
  suggestions(@Query() q: SuggestionQuery): Promise<SuggestionView[]> {
    return this.catalog.listSuggestions(q.status ?? 'PENDING');
  }

  @Post('skill-suggestions/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a suggestion; creates the skill. Audited.' })
  approveSuggestion(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveSuggestionDto,
    @RequestId() requestId: string | null,
  ): Promise<SuggestionView> {
    return this.catalog.approveSuggestion(staff, id, dto, requestId);
  }

  @Post('skill-suggestions/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a suggestion with a reason. Audited.' })
  rejectSuggestion(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectDto,
    @RequestId() requestId: string | null,
  ): Promise<SuggestionView> {
    return this.catalog.rejectSuggestion(staff, id, dto.reason, requestId);
  }
}

/**
 * Admin app API (/admin/*), staff only. Trust & safety (reports, moderation,
 * suspensions) is added here in Part 3.
 */
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    TutorsModule,
    ModerationModule,
    PaymentsModule,
    SettlementModule,
    LiveModule,
    RecordingModule,
    LowBandwidthModule,
  ],
  controllers: [
    AdminModerationController,
    AdminPaymentsController,
    AdminSettlementController,
    AdminAuthController,
    AdminMeController,
    AdminTutorsController,
    AdminCatalogController,
  ],
})
export class AdminAppModule {}
