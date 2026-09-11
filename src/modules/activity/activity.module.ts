import { Global, Module } from '@nestjs/common';
import { ActivityService } from './activity.service';

// PrismaService comes from the @Global PrismaModule.
@Global()
@Module({
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
