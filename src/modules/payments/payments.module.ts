import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import Razorpay from 'razorpay';
import { AppConfig } from '../../platform/config/app-config';
import { UpiModule } from '../../providers/upi/upi.module';
import { LedgerModule } from '../ledger/ledger.service';
import { SessionsModule } from '../sessions/sessions.module';
import {
  HoldProvider,
  LedgerOnlyHoldProvider,
  RazorpayRouteHoldProvider,
  type RazorpayRouteClient,
} from './hold-provider';
import { PAYMENTS_QUEUE, PaymentsService } from './payments.service';

@Module({
  imports: [
    UpiModule,
    LedgerModule,
    SessionsModule,
    BullModule.registerQueue({ name: PAYMENTS_QUEUE }),
  ],
  providers: [
    PaymentsService,
    {
      provide: HoldProvider,
      inject: [AppConfig],
      useFactory: (config: AppConfig): HoldProvider => {
        if (config.env.HOLD_MODE !== 'razorpay_route') return new LedgerOnlyHoldProvider();
        const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = config.env;
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
          throw new Error('HOLD_MODE=razorpay_route needs Razorpay test keys and Route approval.');
        }
        const client = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
        return new RazorpayRouteHoldProvider(client as unknown as RazorpayRouteClient);
      },
    },
  ],
  exports: [PaymentsService, UpiModule, LedgerModule],
})
export class PaymentsModule {}
