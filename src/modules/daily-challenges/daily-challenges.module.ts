import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DailyChallengesController } from './daily-challenges.controller';
import { DailyChallengesService } from './daily-challenges.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [DailyChallengesController],
  providers: [DailyChallengesService],
  exports: [DailyChallengesService],
})
export class DailyChallengesModule {}
