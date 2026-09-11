import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RewardsService } from './rewards.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('rewards')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('rewards')
export class RewardsController {
  constructor(private rewards: RewardsService) {}

  // GET /rewards
  @Get()
  @ApiOperation({ summary: 'List reward catalogue with coin balance and affordability' })
  async list(@CurrentUser() user: any) {
    return this.rewards.list(user.sub);
  }

  // GET /rewards/history
  @Get('history')
  @ApiOperation({ summary: 'Past redemptions, most recent first' })
  async history(@CurrentUser() user: any) {
    return this.rewards.history(user.sub);
  }

  // POST /rewards/:id/redeem
  @Post(':id/redeem')
  @ApiOperation({ summary: 'Spend coins on a reward' })
  async redeem(@CurrentUser() user: any, @Param('id') id: string) {
    return this.rewards.redeem(user.sub, id);
  }
}
