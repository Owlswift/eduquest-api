import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AchievementsService } from './achievements.service';
import { GamificationController } from './gamification.controller';
import { GamificationService } from './gamification.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [GamificationController],
  providers: [AchievementsService, GamificationService],
  exports: [AchievementsService],
})
export class GamificationModule {}
