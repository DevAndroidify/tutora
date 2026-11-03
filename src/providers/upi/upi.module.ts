import { Module } from '@nestjs/common';
import { AppConfig } from '../../platform/config/app-config';
import { FakeUpiGateway } from './fake-upi.gateway';
import { RazorpayUpiGateway } from './razorpay-upi.gateway';
import { ACTIVE_UPI_GATEWAY, UPI_GATEWAYS, type UpiGateway, type UpiGateways } from './upi-gateway';

/**
 * Configured gateways. The fake gateway exists outside production only.
 * Razorpay is built only when test keys are configured.
 */
@Module({
  providers: [
    FakeUpiGateway,
    {
      provide: UPI_GATEWAYS,
      inject: [AppConfig, FakeUpiGateway],
      useFactory: (config: AppConfig, fake: FakeUpiGateway): UpiGateways => {
        const out: UpiGateways = {};
        if (!config.isProduction) out.fake = fake;
        const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = config.env;
        if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && RAZORPAY_WEBHOOK_SECRET) {
          out.razorpay = new RazorpayUpiGateway({
            keyId: RAZORPAY_KEY_ID,
            keySecret: RAZORPAY_KEY_SECRET,
            webhookSecret: RAZORPAY_WEBHOOK_SECRET,
          });
        }
        return out;
      },
    },
    {
      provide: ACTIVE_UPI_GATEWAY,
      inject: [AppConfig, UPI_GATEWAYS],
      useFactory: (config: AppConfig, gateways: UpiGateways): UpiGateway => {
        const gw = gateways[config.env.UPI_PROVIDER];
        if (!gw)
          throw new Error(
            `UPI_PROVIDER=${config.env.UPI_PROVIDER} is not available in this environment.`,
          );
        return gw;
      },
    },
  ],
  exports: [UPI_GATEWAYS, ACTIVE_UPI_GATEWAY, FakeUpiGateway],
})
export class UpiModule {}
