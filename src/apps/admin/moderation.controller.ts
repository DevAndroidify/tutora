import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { CurrentUser, ForApp, RequestId, type AuthUser } from '../../platform/http/request-context';
import { StaffRoles } from '../../modules/identity/auth/guards';
import { CASE_STATUSES, MODERATION_ACTIONS } from '../../modules/moderation/moderation.schema';
import { ModerationService } from '../../modules/moderation/moderation.service';
import { trim } from '../common/dto';

export class CaseListQuery {
  @ApiPropertyOptional({ enum: CASE_STATUSES, default: 'OPEN' })
  @IsOptional()
  @IsIn(CASE_STATUSES)
  status?: (typeof CASE_STATUSES)[number];
}

export class OpenCaseDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subjectUserId!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @Length(5, 1000)
  note!: string;
}

export class CaseActionDto {
  @ApiProperty({ enum: MODERATION_ACTIONS })
  @IsIn(MODERATION_ACTIONS)
  action!: (typeof MODERATION_ACTIONS)[number];

  @ApiProperty({ description: 'Shown to the member for sanctions; kept in the audit log.' })
  @Transform(trim)
  @IsString()
  @Length(5, 1000)
  reason!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 365,
    description: 'Required for SUSPEND and RESTRICT_*.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays?: number;
}

export class LiftDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @Length(5, 1000)
  reason!: string;
}

/** Trust & safety queue. ADMIN and MODERATOR staff. Every decision is audited. */
@ApiTags('admin: trust & safety')
@ApiBearerAuth()
@ForApp('admin')
@StaffRoles('ADMIN', 'MODERATOR')
@Controller('admin/moderation')
export class AdminModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('cases')
  @ApiOperation({ summary: 'Moderation queue, highest priority first.' })
  list(@Query() q: CaseListQuery) {
    return this.moderation.listCases(q.status ?? 'OPEN');
  }

  @Post('cases')
  @ApiOperation({ summary: 'Open a case on a member manually.' })
  open(
    @CurrentUser() staff: AuthUser,
    @Body() dto: OpenCaseDto,
    @RequestId() requestId: string | null,
  ) {
    return this.moderation.openCase(staff, dto.subjectUserId, dto.note, requestId);
  }

  @Get('cases/:id')
  @ApiOperation({ summary: 'Case detail: reports, flags, actions and the member’s history.' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.moderation.getCase(id);
  }

  @Post('cases/:id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign the case to yourself.' })
  assign(@CurrentUser() staff: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.moderation.assign(staff, id);
  }

  @Post('cases/:id/actions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decide the case: dismiss, warn, restrict, suspend or ban.' })
  act(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CaseActionDto,
    @RequestId() requestId: string | null,
  ) {
    return this.moderation.act(staff, id, dto, requestId);
  }

  @Get('users/:userId/sanctions')
  @ApiOperation({ summary: 'A member’s sanctions, active and past.' })
  sanctions(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.moderation.sanctionsFor(userId);
  }

  @Post('sanctions/:id/lift')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Lift an active sanction early.' })
  async lift(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: LiftDto,
    @RequestId() requestId: string | null,
  ): Promise<void> {
    await this.moderation.liftSanction(staff, id, dto.reason, requestId);
  }
}
