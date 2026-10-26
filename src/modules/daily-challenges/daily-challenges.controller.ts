import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { DailyChallengesService } from './daily-challenges.service';

@ApiTags('daily-challenge')
@ApiBearerAuth('access-token')
@Controller('daily-challenge')
@UseGuards(JwtAuthGuard)
export class DailyChallengesController {
  constructor(private daily: DailyChallengesService) {}

  // GET /daily-challenge: today's challenge for the caller's class and their state on it.
  @Get()
  status(@CurrentUser() user: any) {
    return this.daily.status(user.sub);
  }

  // POST /daily-challenge/start: begin or resume the single attempt. Answer with
  // POST /quiz/questions/:id/check and finish with POST /quiz/submit (same sessionId).
  @Post('start')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  start(@CurrentUser() user: any) {
    return this.daily.start(user.sub);
  }
}
