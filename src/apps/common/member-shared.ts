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
  type Type,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser, ForApp, type AuthUser } from '../../platform/http/request-context';
import { RateLimit } from '../../platform/rate-limit/rate-limit';
import {
  UploadsService,
  type PresignedUpload,
  type UploadPurpose,
} from '../../platform/storage/uploads.service';
import type { MemberApp } from '../../modules/identity/identity.schema';
import { ENTITY_TYPES, REPORT_REASONS } from '../../modules/moderation/moderation.schema';
import { ModerationService } from '../../modules/moderation/moderation.service';
import {
  NotificationsService,
  type NotificationView,
} from '../../modules/notifications/notifications.service';
import { trim } from './dto';

export class ReportDto {
  @ApiProperty({ format: 'uuid', description: 'The member being reported.' })
  @IsUUID()
  subjectUserId!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason!: (typeof REPORT_REASONS)[number];

  @ApiPropertyOptional({
    enum: ENTITY_TYPES,
    description: 'What the report is about, if specific.',
  })
  @IsOptional()
  @IsIn(ENTITY_TYPES)
  entityType?: (typeof ENTITY_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityId?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  details?: string;
}

export class PresignDto {
  @ApiProperty({ example: 'image/png' })
  @IsString()
  @MaxLength(100)
  contentType!: string;

  @ApiProperty({ example: 120000 })
  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  sizeBytes!: number;
}

export class NotificationsQuery {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unread?: boolean;
}

/**
 * Builds the reports, notifications and upload controllers for one member app.
 * Both member apps get identical routes under their own prefix and token audience.
 */
export function memberSharedControllers(app: MemberApp, uploadPurpose: UploadPurpose): Type[] {
  @ApiTags(`${app}: reports`)
  @ApiBearerAuth()
  @ForApp(app)
  @Controller(`${app}/reports`)
  class ReportsController {
    constructor(readonly moderation: ModerationService) {}

    @Post()
    @RateLimit('posting')
    @ApiOperation({ summary: 'Report unprofessional or unsafe behaviour. Reviewed by staff.' })
    report(@CurrentUser() user: AuthUser, @Body() dto: ReportDto) {
      return this.moderation.report(user, dto);
    }
  }

  @ApiTags(`${app}: notifications`)
  @ApiBearerAuth()
  @ForApp(app)
  @Controller(`${app}/notifications`)
  class NotificationsController {
    constructor(readonly notifications: NotificationsService) {}

    @Get()
    @ApiOperation({ summary: 'Your in-app notifications, newest first.' })
    list(
      @CurrentUser() user: AuthUser,
      @Query() q: NotificationsQuery,
    ): Promise<NotificationView[]> {
      return this.notifications.list(user, q.unread ?? false);
    }

    @Post(':id/read')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Mark a notification as read.' })
    read(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
    ): Promise<NotificationView> {
      return this.notifications.markRead(user, id);
    }
  }

  @ApiTags(`${app}: uploads`)
  @ApiBearerAuth()
  @ForApp(app)
  @Controller(`${app}/uploads`)
  class UploadsController {
    constructor(readonly uploads: UploadsService) {}

    @Post('presign')
    @ApiOperation({
      summary:
        app === 'student'
          ? 'Get a URL to upload a request attachment (PNG, JPEG, WebP or PDF).'
          : 'Get a URL to upload a short intro video/audio for a bid.',
    })
    presign(@CurrentUser() user: AuthUser, @Body() dto: PresignDto): Promise<PresignedUpload> {
      return this.uploads.presign(user.id, uploadPurpose, dto);
    }
  }

  return [ReportsController, NotificationsController, UploadsController];
}
