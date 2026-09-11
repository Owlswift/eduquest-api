import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'List competitions with join status and participant counts' })
  async list(@CurrentUser() user: any) {
    return this.competitions.list(user.sub);
  }

  // POST /competitions/:id/join
  @Post(':id/join')
  @ApiOperation({ summary: 'Join a competition (idempotent)' })
  async join(@CurrentUser() user: any, @Param('id') id: string) {
    return this.competitions.join(user.sub, id);
  }

  // GET /competitions/:id/leaderboard
  @Get(':id/leaderboard')
  @ApiOperation({ summary: 'Ranking by XP earned since joining this competition' })
  async leaderboard(@CurrentUser() user: any, @Param('id') id: string) {
    return this.competitions.leaderboard(user.sub, id);
  }
}
