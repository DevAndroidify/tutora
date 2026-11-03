import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import type { Request } from 'express';
import { AppConfig } from '../../platform/config/app-config';
import { AppError } from '../../platform/errors/app-error';
import { Public } from '../../platform/http/route-metadata';
import { PaymentsModule } from '../../modules/payments/payments.module';
import { PaymentsService } from '../../modules/payments/payments.service';
import { LiveModule, LiveSessionsService } from '../../modules/live/live-sessions.service';
import { FakeUpiGateway } from '../../providers/upi/fake-upi.gateway';

type RawRequest = Request & { rawBody?: Buffer };

/** Provider webhooks. Signature checked against the raw body; saved first, processed by the worker. */
@ApiTags('webhooks')
@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly live: LiveSessionsService,
  ) {}

  @Post('livekit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'LiveKit room, participant and egress events (signed JWT in Authorization).',
  })
  livekit(@Req() req: RawRequest) {
    return this.live.handleWebhook(req.rawBody, req.headers.authorization);
  }

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Payment provider webhooks (fake, razorpay). Returns 2xx fast.' })
  receive(@Param('provider') provider: string, @Req() req: RawRequest) {
    return this.payments.ingestWebhook(provider, req.rawBody, req.headers);
  }
}

class FakePayDto {
  @ApiPropertyOptional({ description: 'Pay a different amount (to test refunds).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  amountPaise?: number;

  @ApiPropertyOptional({ description: 'Simulate a failed payment.' })
  @IsOptional()
  @IsBoolean()
  fail?: boolean;
}

/**
 * Development-only UPI simulator. Pays a fake order and delivers a correctly signed webhook
 * through the same code path as real providers. Returns 404 in production.
 */
@ApiExcludeController()
@Public()
@Controller('dev')
export class FakeUpiDevController {
  constructor(
    private readonly config: AppConfig,
    private readonly fake: FakeUpiGateway,
    private readonly payments: PaymentsService,
  ) {}

  /** Small page that opens Razorpay Standard Checkout in test mode (dev/razorpay-checkout.html). */
  @Get('razorpay-checkout')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async checkoutPage(): Promise<string> {
    if (this.config.isProduction) throw AppError.notFound('NOT_FOUND', 'Not found.');
    return readFile(resolve(process.cwd(), 'dev/razorpay-checkout.html'), 'utf8');
  }

  /** Join a session room from two browser tabs (dev/livekit-room.html). */
  @Get('livekit-room')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async livekitRoomPage(): Promise<string> {
    if (this.config.isProduction) throw AppError.notFound('NOT_FOUND', 'Not found.');
    return readFile(resolve(process.cwd(), 'dev/livekit-room.html'), 'utf8');
  }

  @Post('fake-upi/orders/:orderId/pay')
  @HttpCode(HttpStatus.OK)
  async pay(@Param('orderId') orderId: string, @Body() dto: FakePayDto) {
    if (this.config.isProduction) throw AppError.notFound('NOT_FOUND', 'Not found.');
    const hook = await this.fake.simulatePayment(orderId, dto);
    const result = await this.payments.ingestWebhook('fake', hook.rawBody, {
      'x-fake-signature': hook.signature,
      'x-fake-event-id': hook.eventId,
    });
    return { orderId, providerPaymentId: hook.paymentId, webhookEventId: hook.eventId, ...result };
  }
}

@Module({
  imports: [PaymentsModule, LiveModule],
  controllers: [WebhooksController, FakeUpiDevController],
})
export class WebhooksAppModule {}
