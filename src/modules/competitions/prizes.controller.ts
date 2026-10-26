import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ClaimPrizeDto } from './dto/claim-prize.dto';
import { PrizesService } from './prizes.service';

@ApiTags('prizes')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('prizes')
export class PrizesController {
  constructor(private prizes: PrizesService) {}

  // GET /prizes: competition prizes I have won, and what each needs from me
  @Get()
  @ApiOperation({ summary: 'Prizes I won in competitions, with status and what is needed to claim' })
  mine(@CurrentUser() user: any) {
    return this.prizes.mine(user.sub);
  }

  // POST /prizes/:id/claim
  @Post(':id/claim')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Claim a prize by giving delivery details before the claim deadline' })
  claim(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ClaimPrizeDto) {
    return this.prizes.claim(user.sub, id, dto);
  }
}
