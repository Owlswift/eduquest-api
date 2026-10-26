import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AttemptsService } from './attempts.service';
import { ProgressController } from './progress.controller';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [ProgressController],
  providers: [AttemptsService],
  exports: [AttemptsService],
})
export class ProgressModule {}
