import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [RewardsController],
  providers: [RewardsService],
})
export class RewardsModule {}
