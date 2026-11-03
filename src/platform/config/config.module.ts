import { Global, Module } from '@nestjs/common';
import { AppConfig, loadAppConfig } from './app-config';

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => loadAppConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
