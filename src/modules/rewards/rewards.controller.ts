import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { RewardsService } from './rewards.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RejectRedemptionDto } from './dto/reject-redemption.dto';

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

  // ─── Admin fulfillment queue ────────────────────────────────────────────────
  // No vendor/payment integration - this is a manually-worked queue for
  // whoever actually sends the airtime/data/etc.

  // GET /rewards/admin/queue
  @Get('admin/queue')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List pending redemptions awaiting manual fulfillment' })
  async adminQueue() {
    return this.rewards.adminQueue();
  }

  // POST /rewards/admin/:id/fulfill
  @Post('admin/:id/fulfill')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Mark a redemption as delivered' })
  async adminFulfill(@Param('id') id: string) {
    return this.rewards.adminFulfill(id);
  }

  // POST /rewards/admin/:id/reject
  @Post('admin/:id/reject')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Mark a redemption as undeliverable and refund the student's coins" })
  async adminReject(@Param('id') id: string, @Body() dto: RejectRedemptionDto) {
    return this.rewards.adminReject(id, dto.reason);
  }
}
