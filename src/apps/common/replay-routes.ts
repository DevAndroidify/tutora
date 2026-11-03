import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser, ForApp, type AuthUser } from '../../platform/http/request-context';
import type { MemberApp } from '../../modules/identity/identity.schema';
import { SESSION_MODES } from '../../modules/lowbandwidth/lowbandwidth.schema';
import { LowBandwidthService } from '../../modules/lowbandwidth/lowbandwidth.service';
import { PoolingService } from '../../modules/pooling/pooling.service';
import { ReplayService } from '../../modules/replay/replay.service';
import { PresignDto } from './member-shared';
import { trim } from './dto';

export class ReplaySearchQuery {
  @ApiProperty({ example: 'integration by parts' })
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  q!: string;
}

export class ModeEventDto {
  @ApiProperty({ enum: SESSION_MODES })
  @IsIn(SESSION_MODES)
  mode!: (typeof SESSION_MODES)[number];

  @ApiPropertyOptional({ description: 'Client-measured downlink, kbps.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  downlinkKbps?: number;

  @ApiPropertyOptional({ example: 'poor-connection' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  reason?: string;
}

export class SnapshotDto {
  @ApiProperty({ description: 'objectKey from .../whiteboard-snapshots/presign' })
  @IsString()
  @MaxLength(300)
  objectKey!: string;

  @ApiPropertyOptional({ description: 'Mark as the final board for the replay.' })
  @IsOptional()
  @IsBoolean()
  isFinal?: boolean;
}

export class TutorNotesDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  summary!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  keyPoints!: string[];
}

/** Replay (Parts 15-16) and low-bandwidth (Part 17) routes for one member app. */
export function replayControllers(app: MemberApp): Type[] {
  @ApiTags(`${app}: replay and low bandwidth`)
  @ApiBearerAuth()
  @ForApp(app)
  @Controller(`${app}/sessions`)
  class ReplayController {
    constructor(
      readonly replay: ReplayService,
      readonly lowBandwidth: LowBandwidthService,
    ) {}

    @Get(':id/replay')
    @ApiOperation({ summary: 'Recording, transcript, notes, flashcards and final whiteboards.' })
    get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
      return this.replay.replay(user, id);
    }

    @Get(':id/replay/search')
    @ApiOperation({
      summary: 'Search this session transcript; results carry timestamps to jump to.',
    })
    search(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Query() q: ReplaySearchQuery,
    ) {
      return this.replay.search(user, id, q.q);
    }

    @Post(':id/mode-events')
    @ApiOperation({ summary: 'Report a switch to FULL_VIDEO, AUDIO_ONLY or WHITEBOARD_ONLY.' })
    mode(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: ModeEventDto,
    ) {
      return this.lowBandwidth.recordMode(user, id, dto);
    }

    @Post(':id/whiteboard-snapshots/presign')
    @ApiOperation({ summary: 'Upload URL for a whiteboard image (PNG/WebP, 2 MB max).' })
    presign(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: PresignDto,
    ) {
      return this.lowBandwidth.presignSnapshot(user, id, dto);
    }

    @Post(':id/whiteboard-snapshots')
    @ApiOperation({ summary: 'Save an uploaded whiteboard snapshot.' })
    snapshot(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: SnapshotDto,
    ) {
      return this.lowBandwidth.addSnapshot(user, id, dto);
    }
  }

  if (app === 'student') {
    @ApiTags('student: group sessions')
    @ApiBearerAuth()
    @ForApp('student')
    @Controller('student/pools')
    class PoolInvitesController {
      constructor(readonly pooling: PoolingService) {}

      @Get('invites')
      @ApiOperation({
        summary: 'Invitations to join a cheaper group session. Other learners stay anonymous.',
      })
      invites(@CurrentUser() user: AuthUser) {
        return this.pooling.listInvites(user);
      }

      @Post('invites/:id/accept')
      @HttpCode(HttpStatus.OK)
      @ApiOperation({ summary: 'Join the group (your request becomes POOLED).' })
      accept(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
        return this.pooling.accept(user, id);
      }

      @Post('invites/:id/decline')
      @HttpCode(HttpStatus.OK)
      @ApiOperation({ summary: 'Decline the invitation.' })
      decline(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
        return this.pooling.decline(user, id);
      }
    }
    return [ReplayController, PoolInvitesController];
  }

  @ApiTags('tutor: replay')
  @ApiBearerAuth()
  @ForApp('tutor')
  @Controller('tutor/sessions')
  class TutorNotesController {
    constructor(readonly replay: ReplayService) {}

    @Put(':id/notes')
    @ApiOperation({
      summary: 'Write the session notes yourself (shown instead of generated notes).',
    })
    notes(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: TutorNotesDto,
    ) {
      return this.replay.writeTutorNotes(user, id, dto);
    }
  }
  return [ReplayController, TutorNotesController];
}
