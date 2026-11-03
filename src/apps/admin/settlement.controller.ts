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
import { AuditService } from '../../platform/audit/audit.service';
import { AppError } from '../../platform/errors/app-error';
import {
  auditActor,
  CurrentUser,
  ForApp,
  RequestId,
  type AuthUser,
} from '../../platform/http/request-context';
import { StaffRoles } from '../../modules/identity/auth/guards';
import { LiveSessionsService } from '../../modules/live/live-sessions.service';
import { RecordingService } from '../../modules/recording/recording.service';
import { DISPUTE_STATUSES } from '../../modules/settlement/settlement.schema';
import { SettlementService } from '../../modules/settlement/settlement.service';
import { LowBandwidthService } from '../../modules/lowbandwidth/lowbandwidth.service';
import { IsISO8601 } from 'class-validator';
import { trim } from '../common/dto';

class NoteDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @Length(5, 1000)
  note!: string;
}

class ResolveDisputeDto extends NoteDto {
  @ApiProperty({ enum: ['RELEASE', 'REFUND'] })
  @IsIn(['RELEASE', 'REFUND'])
  outcome!: 'RELEASE' | 'REFUND';
}

class PayoutDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  tutorUserId!: string;

  @ApiProperty({ description: 'Paise already sent to the tutor by UPI.' })
  @IsInt()
  @Min(100)
  @Max(1_000_000_000)
  amountPaise!: number;

  @ApiProperty({ description: 'UPI transaction reference (UTR).' })
  @Transform(trim)
  @IsString()
  @Length(6, 64)
  reference!: string;
}

class MetricsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  to?: string;
}

class DisputeQuery {
  @ApiPropertyOptional({ enum: DISPUTE_STATUSES })
  @IsOptional()
  @IsIn(DISPUTE_STATUSES)
  status?: (typeof DISPUTE_STATUSES)[number];
}

@ApiTags('admin: settlement')
@ApiBearerAuth()
@ForApp('admin')
@StaffRoles('ADMIN')
@Controller('admin')
export class AdminSettlementController {
  constructor(
    private readonly settlement: SettlementService,
    private readonly recording: RecordingService,
    private readonly live: LiveSessionsService,
    private readonly audit: AuditService,
    private readonly lowBandwidth: LowBandwidthService,
  ) {}

  @Get('metrics/low-bandwidth')
  @ApiOperation({
    summary:
      'Share of sessions that switched to audio-only or whiteboard-only (default: last 30 days).',
  })
  lowBandwidthMetrics(@Query() q: MetricsQuery) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    return this.lowBandwidth.metrics(from, to);
  }

  @Get('disputes')
  @ApiOperation({ summary: 'Disputes, newest first.' })
  disputes(@Query() q: DisputeQuery) {
    return this.settlement.listDisputes(q.status);
  }

  @Post('disputes/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decide a dispute: RELEASE pays the tutor, REFUND returns the money. Audited.',
  })
  resolve(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveDisputeDto,
    @RequestId() requestId: string | null,
  ) {
    return this.settlement.resolveDispute(staff, id, dto.outcome, dto.note, requestId);
  }

  @Post('payments/:id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release held money to the tutor now. Audited.' })
  release(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: NoteDto,
    @RequestId() requestId: string | null,
  ) {
    return this.settlement.adminRelease(staff, id, dto.note, requestId);
  }

  @Post('payments/:id/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund held money to the learner. Audited.' })
  refund(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: NoteDto,
    @RequestId() requestId: string | null,
  ) {
    return this.settlement.adminRefund(staff, id, dto.note, requestId);
  }

  @Post('payouts')
  @ApiOperation({ summary: 'Record a manual UPI payout already sent to a tutor. Audited.' })
  payout(
    @CurrentUser() staff: AuthUser,
    @Body() dto: PayoutDto,
    @RequestId() requestId: string | null,
  ) {
    return this.settlement.recordPayout(staff, dto, requestId);
  }

  @Get('reconciliation')
  @ApiOperation({ summary: 'Ledger vs payment records vs provider. Lists every mismatch.' })
  reconciliation() {
    return this.settlement.reconciliation();
  }

  @Get('sessions/:id/attendance')
  @ApiOperation({ summary: 'Attendance for a session (for disputes).' })
  attendance(@CurrentUser() staff: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.live.attendance(staff, id);
  }

  @Get('sessions/:id/recording')
  @ApiOperation({
    summary: 'Recording of a disputed session. Only while a dispute is open; audited.',
  })
  async recordingView(
    @CurrentUser() staff: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @RequestId() requestId: string | null,
  ) {
    if (!(await this.settlement.hasOpenDispute(id))) {
      throw AppError.forbidden(
        'NO_OPEN_DISPUTE',
        'Staff can only view recordings of sessions with an open dispute.',
      );
    }
    await this.audit.record({
      actor: auditActor(staff),
      action: 'recording.viewed_by_staff',
      entityType: 'session',
      entityId: id,
      requestId,
    });
    return this.recording.viewForStaff(id);
  }
}
