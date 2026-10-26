import { Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClassLevel, ExamType, PrizeAwardStatus, QuestionStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminCompetitionsService } from './admin-competitions.service';
import { AdminQuestionsService } from './admin-questions.service';
import { CreateCompetitionDto, UpdateCompetitionDto } from './dto/competition.dto';
import { CloseAwardDto, CloseCompetitionDto, FulfilAwardDto, ReasonDto } from './dto/competition-actions.dto';
import { AdminCompetitionResultsService } from './admin-competition-results.service';
import { PrizesService } from '../competitions/prizes.service';
import { AdminRewardsService } from './admin-rewards.service';
import { JobsService } from '../jobs/jobs.service';
import { NotFoundException } from '@nestjs/common';
import { CreateRewardDto, UpdateRewardDto } from './dto/reward.dto';
import { CreateQuestionDto, SetStatusDto, UpdateQuestionDto } from './dto/question.dto';

@ApiTags('admin')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminContentController {
  constructor(
    private questions: AdminQuestionsService,
    private competitions: AdminCompetitionsService,
    private results: AdminCompetitionResultsService,
    private prizes: PrizesService,
    private rewards: AdminRewardsService,
    private jobs: JobsService,
  ) {}

  // ─── Question bank ──────────────────────────────────────────────────────────

  @Get('questions')
  @ApiOperation({ summary: 'Search the question bank with performance stats and quality flags' })
  listQuestions(
    @Query('subjectId') subjectId?: string,
    @Query('classLevel') classLevel?: ClassLevel,
    @Query('topic') topic?: string,
    @Query('status') status?: QuestionStatus,
    @Query('examType') examType?: ExamType,
    @Query('q') q?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize = 25,
  ) {
    return this.questions.list({ subjectId, classLevel, topic, status, examType, q, page, pageSize });
  }

  @Get('questions/:id')
  getQuestion(@Param('id') id: string) {
    return this.questions.get(id);
  }

  @Post('questions')
  @ApiOperation({ summary: 'Create a question (a draft unless status says otherwise)' })
  createQuestion(@CurrentUser() admin: any, @Body() dto: CreateQuestionDto) {
    return this.questions.create(admin.sub, dto);
  }

  @Patch('questions/:id')
  @ApiOperation({ summary: 'Edit a question; send options and correctIndex together to change the answers' })
  updateQuestion(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    return this.questions.update(admin.sub, id, dto);
  }

  @Patch('questions/:id/status')
  @ApiOperation({ summary: 'Publish, retire or return to draft' })
  setQuestionStatus(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.questions.setStatus(admin.sub, id, dto.status);
  }

  @Delete('questions/:id')
  @ApiOperation({ summary: 'Delete an unused draft (retire anything else)' })
  deleteQuestion(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.questions.remove(admin.sub, id);
  }

  // ─── Competitions ───────────────────────────────────────────────────────────

  @Get('competitions')
  listCompetitions() {
    return this.competitions.list();
  }

  @Get('competitions/:id')
  getCompetition(@Param('id') id: string) {
    return this.competitions.get(id);
  }

  @Post('competitions')
  createCompetition(@CurrentUser() admin: any, @Body() dto: CreateCompetitionDto) {
    return this.competitions.create(admin.sub, dto);
  }

  @Patch('competitions/:id')
  @ApiOperation({ summary: 'Edit a competition; dates are locked once it has started' })
  updateCompetition(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: UpdateCompetitionDto) {
    return this.competitions.update(admin.sub, id, dto);
  }

  @Post('competitions/:id/publish')
  @ApiOperation({ summary: 'Freeze the rules and pick the questions. A published competition opens at its start date' })
  publishCompetition(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.competitions.publish(admin.sub, id);
  }

  @Post('competitions/:id/close')
  @ApiOperation({ summary: 'End a running competition now (needs a reason)' })
  closeCompetition(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: CloseCompetitionDto) {
    return this.competitions.closeNow(admin.sub, id, dto.reason);
  }

  @Delete('competitions/:id')
  @ApiOperation({ summary: 'Delete a draft, or a published competition nobody has joined' })
  deleteCompetition(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.competitions.remove(admin.sub, id);
  }

  // ─── Results: validation, finalising, prizes ────────────────────────────────

  @Get('competitions/:id/entries')
  @ApiOperation({ summary: 'Every entry with score, time, review flags and identical-sheet counts' })
  entries(@Param('id') id: string) {
    return this.results.entries(id);
  }

  @Post('competitions/:id/validate')
  @ApiOperation({ summary: 'Grade unsubmitted sittings and flag identical answer sheets (closed competitions)' })
  validate(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.results.validate(admin.sub, id);
  }

  @Post('competitions/:id/entries/:userId/disqualify')
  disqualify(@CurrentUser() admin: any, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: ReasonDto) {
    return this.results.disqualify(admin.sub, id, userId, dto.reason);
  }

  @Post('competitions/:id/entries/:userId/reinstate')
  reinstate(@CurrentUser() admin: any, @Param('id') id: string, @Param('userId') userId: string) {
    return this.results.reinstate(admin.sub, id, userId);
  }

  @Post('competitions/:id/finalise')
  @ApiOperation({ summary: 'Confirm results: final ranks, prize awards and certificates (once)' })
  finalise(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.results.finalise(admin.sub, id);
  }

  @Post('competitions/:id/archive')
  archive(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.results.archive(admin.sub, id);
  }

  @Get('prize-awards')
  @ApiOperation({ summary: 'Prize awards with winner contact and claim details; filter by status or overdue claims' })
  prizeAwards(
    @Query('status') status?: PrizeAwardStatus,
    @Query('competitionId') competitionId?: string,
    @Query('overdue') overdue?: string,
  ) {
    return this.prizes.adminList({ status, competitionId, overdue: overdue === 'true' });
  }

  @Post('prize-awards/:id/verify')
  verifyAward(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.prizes.verify(admin.sub, id);
  }

  @Post('prize-awards/:id/fulfil')
  @ApiOperation({ summary: 'Mark a verified prize delivered (a coin prize is paid now, once)' })
  fulfilAward(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: FulfilAwardDto) {
    return this.prizes.fulfil(admin.sub, id, dto.note);
  }

  @Post('prize-awards/:id/forfeit')
  @ApiOperation({ summary: 'Unclaimed or unreachable: forfeit and (by default) pass to the next place' })
  forfeitAward(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: CloseAwardDto) {
    return this.prizes.forfeit(admin.sub, id, dto.reason, dto.promote ?? true);
  }

  @Post('prize-awards/:id/reject')
  @ApiOperation({ summary: 'Verification failed: reject and (by default) pass to the next place' })
  rejectAward(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: CloseAwardDto) {
    return this.prizes.reject(admin.sub, id, dto.reason, dto.promote ?? true);
  }

  // ─── Rewards catalogue ──────────────────────────────────────────────────────

  @Get('rewards')
  @ApiOperation({ summary: 'The whole rewards catalogue, including switched-off rewards, with redemption counts' })
  listRewards() {
    return this.rewards.list();
  }

  @Post('rewards')
  createReward(@CurrentUser() admin: any, @Body() dto: CreateRewardDto) {
    return this.rewards.create(admin.sub, dto);
  }

  @Patch('rewards/:id')
  @ApiOperation({ summary: 'Edit price, stock (null = unlimited), copy or visibility. Past redemptions keep their price' })
  updateReward(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: UpdateRewardDto) {
    return this.rewards.update(admin.sub, id, dto);
  }

  @Delete('rewards/:id')
  @ApiOperation({ summary: 'Delete a reward nobody redeemed (otherwise switch it off)' })
  deleteReward(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.rewards.remove(admin.sub, id);
  }

  // ─── Scheduled jobs ─────────────────────────────────────────────────────────

  @Get('jobs')
  @ApiOperation({ summary: 'Scheduled tasks and whether the scheduler is running (needs REDIS_URL)' })
  listJobs() {
    return this.jobs.describe();
  }

  @Post('jobs/:name/run')
  @ApiOperation({ summary: 'Run a scheduled task now. Safe to repeat: each message is sent at most once' })
  async runJob(@Param('name') name: string) {
    const out = await this.jobs.runNow(name);
    if (!out) throw new NotFoundException(`No such task: ${name}`);
    return out;
  }
}
