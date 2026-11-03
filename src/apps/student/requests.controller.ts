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
import type { Page } from '../../modules/catalog/catalog.service';
import {
  BiddingService,
  type BidSort,
  type StudentBidView,
} from '../../modules/bidding/bidding.service';
import { REQUEST_STATUSES, SKILL_LEVELS } from '../../modules/requests/requests.schema';
import { RequestsService, type RequestView } from '../../modules/requests/requests.service';
import { PageQuery, trim } from '../common/dto';

export class CreateRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skillId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  topicId?: string;

  @ApiProperty({ enum: SKILL_LEVELS })
  @IsIn(SKILL_LEVELS)
  level!: (typeof SKILL_LEVELS)[number];

  @ApiProperty({ example: 'How do I read candlestick patterns?' })
  @Transform(trim)
  @IsString()
  @Length(5, 140)
  title!: string;

  @ApiProperty({ maxLength: 4000 })
  @Transform(trim)
  @IsString()
  @Length(10, 4000)
  description!: string;

  @ApiPropertyOptional({ example: 'Hindi' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 40)
  preferredLanguage?: string;

  @ApiPropertyOptional({ description: 'Budget hint in paise (₹500 = 50000).' })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(100_000_000)
  budgetHintPaise?: number;
}

export class UpdateRequestDto extends PartialType(CreateRequestDto) {}

export class RequestListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: REQUEST_STATUSES })
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  status?: (typeof REQUEST_STATUSES)[number];
}

export class AttachDto {
  @ApiProperty({ description: 'objectKey returned by POST /student/uploads/presign.' })
  @IsString()
  @MaxLength(300)
  objectKey!: string;

  @ApiProperty({ example: 'question.png' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  fileName!: string;
}

export class BidSortQuery {
  @ApiPropertyOptional({ enum: ['score', 'price', 'time'], default: 'score' })
  @IsOptional()
  @IsIn(['score', 'price', 'time'])
  sort?: BidSort;
}

@ApiTags('student: learning requests')
@ApiBearerAuth()
@ForApp('student')
@Controller('student/requests')
export class StudentRequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly bidding: BiddingService,
  ) {}

  @Post()
  @RateLimit('posting')
  @ApiOperation({ summary: 'Create a draft request. Contact details are hidden automatically.' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRequestDto): Promise<RequestView> {
    return this.requests.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Your requests.' })
  list(@CurrentUser() user: AuthUser, @Query() q: RequestListQuery): Promise<Page<RequestView>> {
    return this.requests.listOwn(user, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of your requests.' })
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RequestView> {
    return this.requests.getOwn(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a draft.' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRequestDto,
  ): Promise<RequestView> {
    return this.requests.update(user, id, dto);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit('posting')
  @ApiOperation({ summary: 'Open the request for bids (DRAFT -> OPEN).' })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RequestView> {
    return this.requests.publish(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a draft or open request; open bids expire.' })
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RequestView> {
    await this.bidding.cancelRequest(user, id);
    return this.requests.getOwn(user, id);
  }

  @Post(':id/attachments')
  @ApiOperation({ summary: 'Attach a file you uploaded with a presigned URL.' })
  attach(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AttachDto,
  ): Promise<RequestView> {
    return this.requests.addAttachment(user, id, dto);
  }

  @Get(':id/bids')
  @ApiOperation({ summary: 'All bids on your request, with prices and a score explanation.' })
  bids(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: BidSortQuery,
  ): Promise<StudentBidView[]> {
    return this.bidding.listForStudent(user, id, q.sort ?? 'score');
  }
}
