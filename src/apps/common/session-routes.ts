import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AppError } from '../../platform/errors/app-error';
import { CurrentUser, ForApp, type AuthUser } from '../../platform/http/request-context';
import type { MemberApp } from '../../modules/identity/identity.schema';
import { LiveSessionsService } from '../../modules/live/live-sessions.service';
import { MasteryService } from '../../modules/mastery/mastery.service';
import { ModerationService } from '../../modules/moderation/moderation.service';
import { RecordingService } from '../../modules/recording/recording.service';
import { BookingService } from '../../modules/sessions/booking.service';
import { DISPUTE_REASONS } from '../../modules/settlement/settlement.schema';
import { SettlementService } from '../../modules/settlement/settlement.service';
import { trim } from './dto';

export class ConsentDto {
  @ApiProperty({ description: 'true = allow recording this session.' })
  @IsBoolean()
  granted!: boolean;
}

export class DisputeDto {
  @ApiProperty({ enum: DISPUTE_REASONS })
  @IsIn(DISPUTE_REASONS)
  reason!: (typeof DISPUTE_REASONS)[number];

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  details?: string;
}

export class ReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class QuizAnswersDto {
  @ApiProperty({
    type: [Number],
    description: 'Chosen option index per question, or [rating] for a self-check.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(5, { each: true })
  answers!: number[];
}

/** Live-session routes shared by the student and tutor apps (each under its own prefix and tokens). */
export function sessionControllers(app: MemberApp): Type[] {
  @ApiTags(`${app}: live sessions`)
  @ApiBearerAuth()
  @ForApp(app)
  @Controller(`${app}/sessions`)
  class SessionsController {
    constructor(
      readonly live: LiveSessionsService,
      readonly recording: RecordingService,
    ) {}

    @Post(':id/join-token')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
      summary:
        'Short-lived LiveKit token for this session room (assigned tutor or paid learner only).',
    })
    joinToken(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
      return this.live.joinToken(user, id);
    }

    @Get(':id/attendance')
    @ApiOperation({ summary: 'Time each person spent in the room, from LiveKit events.' })
    attendance(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
      return this.live.attendance(user, id);
    }

    @Post(':id/consent')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
      summary: 'Allow or refuse recording. Recording starts only when everyone allows it.',
    })
    consent(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: ConsentDto,
    ) {
      return this.recording.setConsent(user, id, dto.granted);
    }

    @Get(':id/recording')
    @ApiOperation({ summary: 'Recording status and a short-lived playback URL when ready.' })
    recordingView(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
      return this.recording.view(user, id);
    }
  }

  if (app === 'tutor') return [SessionsController];

  @ApiTags('student: after the session')
  @ApiBearerAuth()
  @ForApp('student')
  @Controller('student')
  class StudentOutcomeController {
    constructor(
      readonly settlement: SettlementService,
      readonly mastery: MasteryService,
      readonly booking: BookingService,
      readonly moderation: ModerationService,
    ) {}

    @Post('sessions/:id/disputes')
    @ApiOperation({
      summary: 'Dispute a finished session within the dispute window. Freezes your payment.',
    })
    dispute(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: DisputeDto,
    ) {
      return this.settlement.openDispute(user, id, dto);
    }

    @Post('sessions/:id/review')
    @ApiOperation({ summary: 'Rate the tutor after attending.' })
    async review(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: ReviewDto,
    ) {
      const session = await this.booking.getSession(id);
      const mine = session
        ? (await this.booking.participantsOf(id)).find((p) => p.studentUserId === user.id)
        : null;
      if (!session || !mine)
        throw AppError.forbidden('NOT_IN_SESSION', 'You are not part of this session.');
      if (mine.status !== 'ATTENDED')
        throw AppError.conflict('NOT_ATTENDED', 'You can review a session you attended.');
      const comment = await this.moderation.screen(user.id, dto.comment ?? '', {
        entityType: 'SESSION',
        entityId: id,
        field: 'review',
      });
      return this.mastery.addReview({
        sessionId: id,
        participantId: mine.id,
        studentUserId: user.id,
        tutorUserId: session.tutorUserId,
        skillId: session.skillId,
        rating: dto.rating,
        comment,
      });
    }

    @Get('quizzes')
    @ApiOperation({ summary: 'Exit quizzes and 7-day rechecks you can take now. No answer keys.' })
    quizzes(@CurrentUser() user: AuthUser) {
      return this.mastery.listForStudent(user);
    }

    @Post('quizzes/:id/submit')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Submit answers. Results never affect payments.' })
    submit(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Body() dto: QuizAnswersDto,
    ) {
      return this.mastery.submit(user, id, dto.answers);
    }
  }

  return [SessionsController, StudentOutcomeController];
}
