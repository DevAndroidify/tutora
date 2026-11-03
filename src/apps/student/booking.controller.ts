import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { CurrentUser, ForApp, type AuthUser } from '../../platform/http/request-context';
import { Idempotent } from '../../platform/idempotency/idempotency.interceptor';
import {
  PaymentsService,
  type CheckoutView,
  type PaymentView,
} from '../../modules/payments/payments.service';
import { BookingService, type BookingView } from '../../modules/sessions/booking.service';

/** Body Razorpay Standard Checkout hands to the success handler (field names as Razorpay sends them). */
export class ConfirmCheckoutDto {
  @ApiProperty()
  @IsString()
  @Length(1, 100)
  razorpay_order_id!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 100)
  razorpay_payment_id!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  razorpay_signature!: string;
}

@ApiTags('student: booking and payment')
@ApiBearerAuth()
@ForApp('student')
@Controller('student')
export class StudentBookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly payments: PaymentsService,
  ) {}

  @Post('bids/:id/accept')
  @ApiOperation({
    summary: `Accept a bid. Reserves the tutor and starts the payment window; other bids are held.`,
  })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BookingView> {
    return this.booking.acceptBid(user, id);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Your bookings and sessions.' })
  sessions(@CurrentUser() user: AuthUser): Promise<BookingView[]> {
    return this.booking.listForStudent(user);
  }

  @Post('participants/:id/payments')
  @Idempotent()
  @ApiOperation({
    summary:
      'Start paying for a booking with UPI. Returns only the order id, amount, currency and public checkout config.',
  })
  pay(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CheckoutView> {
    return this.payments.initiate(user, id);
  }

  @Get('payments/:id')
  @ApiOperation({ summary: 'Payment status.' })
  payment(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PaymentView> {
    return this.payments.get(user, id);
  }

  @Post('payments/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Checkout success callback. Verifies the signature and checks with the provider; webhooks stay authoritative.',
  })
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmCheckoutDto,
  ): Promise<PaymentView> {
    return this.payments.confirmCheckout(user, id, {
      providerOrderId: dto.razorpay_order_id,
      providerPaymentId: dto.razorpay_payment_id,
      signature: dto.razorpay_signature,
    });
  }
}
