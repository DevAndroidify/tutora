import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  type Type,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { CurrentUser, ForApp, type AuthUser } from '../../platform/http/request-context';
import { RateLimit } from '../../platform/rate-limit/rate-limit';
import { GroupBookingService } from '../../modules/group-booking/group-booking.service';
import { VerifiedTutorGuard } from '../../modules/tutors/verified-tutor.guard';
import { CreateBidDto } from '../tutor/marketplace.controller';

export class CreatePoolBidDto extends CreateBidDto {
  @ApiProperty({
    minimum: 2,
    example: 2,
    description: 'The session runs only if at least this many learners pay.',
  })
  @IsInt()
  @Min(2)
  @Max(50)
  minSeats!: number;

  @ApiProperty({
    minimum: 2,
    example: 5,
    description: 'At most this many learners can pay (<= POOL_MAX_SEATS).',
  })
  @IsInt()
  @Min(2)
  @Max(50)
  maxSeats!: number;
}

/** Part 19 routes: tutors bid on groups, members accept an offer and each pays for their own seat. */
export function groupControllers(app: 'student' | 'tutor'): Type[] {
  if (app === 'tutor') {
    @ApiTags('tutor: group sessions')
    @ApiBearerAuth()
    @ForApp('tutor')
    @UseGuards(VerifiedTutorGuard)
    @Controller('tutor/pools')
    class TutorPoolsController {
      constructor(readonly groups: GroupBookingService) {}

      @Get()
      @ApiOperation({
        summary: 'Groups you can bid on (your approved skills). Members stay anonymous.',
      })
      list(@CurrentUser() user: AuthUser) {
        return this.groups.listOpenPools(user);
      }

      @Post(':id/bids')
      @RateLimit('bidding')
      @ApiOperation({ summary: 'Sealed group bid: seat price, min and max seats, proposed time.' })
      bid(
        @CurrentUser() user: AuthUser,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() dto: CreatePoolBidDto,
      ) {
        return this.groups.placeBid(user, id, dto);
      }
    }
    return [TutorPoolsController];
  }

  @ApiTags('student: group sessions')
  @ApiBearerAuth()
  @ForApp('student')
  @Controller('student/pools')
  class StudentPoolBidsController {
    constructor(readonly groups: GroupBookingService) {}

    @Get(':id/bids')
    @ApiOperation({ summary: 'Offers on your group, with seat price, seat limits and score.' })
    bids(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
      return this.groups.listBids(user, id);
    }

    @Post(':id/bids/:bidId/accept')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
      summary:
        'Accept the group offer and reserve your seat. Then pay via /student/participants/:id/payments.',
    })
    accept(
      @CurrentUser() user: AuthUser,
      @Param('id', new ParseUUIDPipe()) id: string,
      @Param('bidId', new ParseUUIDPipe()) bidId: string,
    ) {
      return this.groups.acceptOffer(user, id, bidId);
    }
  }
  return [StudentPoolBidsController];
}
