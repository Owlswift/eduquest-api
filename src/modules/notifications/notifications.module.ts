import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
