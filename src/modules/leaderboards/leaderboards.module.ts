import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LeaderboardsController } from './leaderboards.controller';
import { LeaderboardsService } from './leaderboards.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [LeaderboardsController],
  providers: [LeaderboardsService],
  exports: [LeaderboardsService],
})
export class LeaderboardsModule {}
