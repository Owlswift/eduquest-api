import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AchievementsService } from './achievements.service';

@ApiTags('achievements')
@ApiBearerAuth('access-token')
@Controller('achievements')
@UseGuards(JwtAuthGuard)
export class GamificationController {
  constructor(private achievements: AchievementsService) {}

  // GET /achievements: the catalogue with the caller's progress and unlocks.
  @Get()
  async list(@CurrentUser() user: any) {
    const items = await this.achievements.list(user.sub);
    return {
      unlockedCount: items.filter((i) => i.unlocked).length,
      total: items.length,
      items,
    };
  }
}
