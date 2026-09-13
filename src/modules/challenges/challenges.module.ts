import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChallengesController } from './challenges.controller';
import { ChallengesService } from './challenges.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [ChallengesController],
  providers: [ChallengesService],
})
export class ChallengesModule {}
