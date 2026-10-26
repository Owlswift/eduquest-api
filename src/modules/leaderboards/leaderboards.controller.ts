import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClassLevel, Region } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BadRequestException } from '@nestjs/common';
import { LeaderboardPeriod, LeaderboardScope, LeaderboardsService } from './leaderboards.service';

const SCOPES: LeaderboardScope[] = ['national', 'state', 'region', 'class'];
const PERIODS: LeaderboardPeriod[] = ['all', 'weekly', 'monthly'];

@ApiTags('leaderboards')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('leaderboards')
export class LeaderboardsController {
  constructor(private boards: LeaderboardsService) {}

  // GET /leaderboards/options
  @Get('options')
  @ApiOperation({ summary: 'The boards this student can view: periods, their own state/zone/class, regions and subjects' })
  options(@CurrentUser() user: any) {
    return this.boards.options(user.sub);
  }

  // GET /leaderboards?scope=&period=&subjectId=&state=&region=&classLevel=&limit=
  @Get()
  @ApiOperation({
    summary: 'A ranking that says what it ranks: XP (lifetime, week, month) or correct answers in one subject, within a scope',
  })
  board(
    @CurrentUser() user: any,
    @Query('scope') scope: string = 'national',
    @Query('period') period: string = 'all',
    @Query('subjectId') subjectId?: string,
    @Query('state') state?: string,
    @Query('region') region?: Region,
    @Query('classLevel') classLevel?: ClassLevel,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    if (!SCOPES.includes(scope as LeaderboardScope)) throw new BadRequestException(`scope must be one of ${SCOPES.join(', ')}`);
    if (!PERIODS.includes(period as LeaderboardPeriod)) throw new BadRequestException(`period must be one of ${PERIODS.join(', ')}`);
    if (region && !Object.values(Region).includes(region)) throw new BadRequestException('Unknown region');
    if (classLevel && !Object.values(ClassLevel).includes(classLevel)) throw new BadRequestException('Unknown class level');
    return this.boards.board(user.sub, {
      scope: scope as LeaderboardScope,
      period: period as LeaderboardPeriod,
      subjectId,
      state,
      region,
      classLevel,
      limit: Math.min(Math.max(limit, 1), 100),
    });
  }
}
