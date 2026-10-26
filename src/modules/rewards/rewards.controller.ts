import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { RewardsService } from './rewards.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { FulfilRedemptionDto, RejectRedemptionDto } from './dto/reject-redemption.dto';

@ApiTags('rewards')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('rewards')
export class RewardsController {
  constructor(private rewards: RewardsService) {}

  // GET /rewards
  @Get()
  @ApiOperation({ summary: 'Active rewards with stock, affordability and coins still needed' })
  async list(@CurrentUser() user: any) {
    return this.rewards.list(user.sub);
  }

  // GET /rewards/history
  @Get('history')
  @ApiOperation({ summary: 'My redemptions with status; pending ones can be cancelled' })
  async history(@CurrentUser() user: any) {
    return this.rewards.history(user.sub);
  }

  // POST /rewards/redemptions/:id/cancel
  @Post('redemptions/:id/cancel')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Take back a pending request: coins and stock are returned' })
  async cancel(@CurrentUser() user: any, @Param('id') id: string) {
    return this.rewards.cancel(user.sub, id);
  }

  // POST /rewards/:id/redeem
  @Post(':id/redeem')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Spend coins on a reward (takes one unit of stock)' })
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
  @ApiOperation({ summary: 'Pending and approved redemptions awaiting delivery' })
  async adminQueue() {
    return this.rewards.adminQueue();
  }

  // POST /rewards/admin/:id/approve
  @Post('admin/:id/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Mark a pending redemption as checked and being arranged' })
  async adminApprove(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.rewards.adminApprove(admin.sub, id);
  }

  // POST /rewards/admin/:id/fulfill
  @Post('admin/:id/fulfill')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Mark a redemption as delivered' })
  async adminFulfill(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: FulfilRedemptionDto) {
    return this.rewards.adminFulfill(admin.sub, id, dto.note);
  }

  // POST /rewards/admin/:id/reject
  @Post('admin/:id/reject')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Mark a redemption as undeliverable: refunds the student's coins and restocks" })
  async adminReject(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: RejectRedemptionDto) {
    return this.rewards.adminReject(admin.sub, id, dto.reason);
  }
}
