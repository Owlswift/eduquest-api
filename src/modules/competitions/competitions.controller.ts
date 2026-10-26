import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CompetitionsService } from './competitions.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('competitions')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('competitions')
export class CompetitionsController {
  constructor(private competitions: CompetitionsService) {}

  // GET /competitions
  @Get()
  @ApiOperation({ summary: 'Published competitions with eligibility, my entry and counts' })
  async list(@CurrentUser() user: any) {
    return this.competitions.list(user.sub);
  }

  // GET /competitions/mine: my competition history (declared before :id)
  @Get('mine')
  @ApiOperation({ summary: 'Competitions I entered: result, rank, prize and certificate' })
  async mine(@CurrentUser() user: any) {
    return this.competitions.history(user.sub);
  }

  // GET /competitions/:id
  @Get(':id')
  @ApiOperation({ summary: 'Rules, scoring, eligibility, prizes and my entry' })
  async detail(@CurrentUser() user: any, @Param('id') id: string) {
    return this.competitions.detail(user.sub, id);
  }

  // POST /competitions/:id/join
  @Post(':id/join')
  @ApiOperation({ summary: 'Enter a competition (idempotent; checks eligibility)' })
  async join(@CurrentUser() user: any, @Param('id') id: string) {
    return this.competitions.join(user.sub, id);
  }

  // POST /competitions/:id/start
  @Post(':id/start')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Begin (or resume) your single sitting. Lock answers with POST /quiz/questions/:id/check and finish with POST /quiz/submit',
  })
  async start(@CurrentUser() user: any, @Param('id') id: string) {
    return this.competitions.start(user.sub, id);
  }

  // GET /competitions/:id/leaderboard
  @Get(':id/leaderboard')
  @ApiOperation({ summary: 'Ranking by this competition\'s own score (never lifetime XP)' })
  async leaderboard(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.competitions.leaderboard(user.sub, id, Math.min(Math.max(limit, 1), 100));
  }

  // GET /competitions/:id/review
  @Get(':id/review')
  @ApiOperation({ summary: 'Your sitting with the right answers, after the competition has closed' })
  async review(@CurrentUser() user: any, @Param('id') id: string) {
    return this.competitions.review(user.sub, id);
  }
}
