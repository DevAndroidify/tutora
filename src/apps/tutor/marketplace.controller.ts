import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser, ForApp, type AuthUser } from '../../platform/http/request-context';
import { RateLimit } from '../../platform/rate-limit/rate-limit';
import { BID_STATUSES } from '../../modules/bidding/bidding.schema';
import { BiddingService, type OwnBidView } from '../../modules/bidding/bidding.service';
import { SKILL_LEVELS } from '../../modules/requests/requests.schema';
import { RequestsService } from '../../modules/requests/requests.service';
import { TutorsService } from '../../modules/tutors/tutors.service';
import { BookingService, type BookingView } from '../../modules/sessions/booking.service';
import { SettlementService } from '../../modules/settlement/settlement.service';
import { VerifiedTutorGuard } from '../../modules/tutors/verified-tutor.guard';
import { PageQuery, trim } from '../common/dto';

export class BrowseRequestsQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Must be one of your approved skills.' })
  @IsOptional()
  @IsUUID()
  skillId?: string;

  @ApiPropertyOptional({ enum: SKILL_LEVELS })
  @IsOptional()
  @IsIn(SKILL_LEVELS)
  level?: (typeof SKILL_LEVELS)[number];
}

export class CreateBidDto {
  @ApiProperty({ description: 'Price per seat in paise (₹499 = 49900).', example: 49900 })
  @IsInt()
  @Min(100)
  @Max(100_000_000)
  seatPricePaise!: number;

  @ApiProperty({ example: '2026-11-05T14:30:00.000Z' })
  @IsISO8601({ strict: true })
  proposedStartAt!: string;

  @ApiProperty({ minimum: 15, maximum: 240, example: 60 })
  @IsInt()
  @Min(15)
  @Max(240)
  durationMinutes!: number;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Required unless approachMediaKey is given.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  approachText?: string;

  @ApiPropertyOptional({
    description: 'objectKey from POST /tutor/uploads/presign (about 30 seconds).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  approachMediaKey?: string;
}

export class UpdateBidDto extends PartialType(CreateBidDto) {}

export class OwnBidsQuery {
  @ApiPropertyOptional({ enum: BID_STATUSES })
  @IsOptional()
  @IsIn(BID_STATUSES)
  status?: (typeof BID_STATUSES)[number];
}

@ApiTags('tutor: marketplace')
@ApiBearerAuth()
@ForApp('tutor')
@UseGuards(VerifiedTutorGuard)
@Controller('tutor')
export class TutorMarketplaceController {
  constructor(
    private readonly requests: RequestsService,
    private readonly bidding: BiddingService,
    private readonly tutors: TutorsService,
    private readonly booking: BookingService,
    private readonly settlement: SettlementService,
  ) {}

  @Get('earnings')
  @ApiOperation({ summary: 'What you have earned, what is still held, and payouts recorded.' })
  earnings(@CurrentUser() user: AuthUser) {
    return this.settlement.earnings(user);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Your booked sessions (pending payment, scheduled, past).' })
  sessions(@CurrentUser() user: AuthUser): Promise<BookingView[]> {
    return this.booking.listForTutor(user);
  }

  @Get('requests')
  @ApiOperation({ summary: 'Open requests in skills you are approved to teach, with bid counts.' })
  async browse(@CurrentUser() user: AuthUser, @Query() q: BrowseRequestsQuery) {
    const teachable = await this.tutors.teachableSkillIds(user.id);
    const skillIds = q.skillId ? teachable.filter((id) => id === q.skillId) : teachable;
    const page = await this.requests.browseOpen({ ...q, skillIds, excludeStudentId: user.id });
    const counts = await this.bidding.countsFor(page.items.map((r) => r.id));
    return { ...page, items: page.items.map((r) => ({ ...r, bidCount: counts.get(r.id) ?? 0 })) };
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'One request: details, bid count and only your own bid.' })
  request(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bidding.tutorRequestView(user, id);
  }

  @Post('requests/:id/bids')
  @RateLimit('bidding')
  @ApiOperation({ summary: 'Place a sealed bid. One active bid per request.' })
  bid(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateBidDto,
  ): Promise<OwnBidView> {
    return this.bidding.create(user, id, dto);
  }

  @Get('bids')
  @ApiOperation({ summary: 'Your bids.' })
  myBids(@CurrentUser() user: AuthUser, @Query() q: OwnBidsQuery): Promise<OwnBidView[]> {
    return this.bidding.listOwn(user, q.status);
  }

  @Patch('bids/:id')
  @RateLimit('bidding')
  @ApiOperation({ summary: 'Edit a submitted bid.' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBidDto,
  ): Promise<OwnBidView> {
    return this.bidding.update(user, id, dto);
  }

  @Post('bids/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a submitted bid.' })
  withdraw(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<OwnBidView> {
    return this.bidding.withdraw(user, id);
  }
}
