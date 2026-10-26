import { Controller, Get, Patch, Post, Put, Delete, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { LeaderboardsService } from '../leaderboards/leaderboards.service';
import { UsersService } from './users.service';
import { ActivityService } from '../activity/activity.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CompleteChallengeDto } from './dto/complete-challenge.dto';
import { SafeguardingService } from './safeguarding.service';
import { AcceptPolicyDto, GuardianConsentDto } from './dto/safeguarding.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private users: UsersService,
    private activity: ActivityService,
    private leaderboards: LeaderboardsService,
    private safeguarding: SafeguardingService,
  ) {}

  // GET /users/me
  @Get('me')
  async getProfile(@CurrentUser() user: any) {
    const userData = await this.users.findById(user.sub);
    return {
      id: userData.id,
      fullName: userData.fullName,
      username: userData.username,
      email: userData.email,
      phone: userData.phone,
      classLevel: userData.classLevel,
      state: userData.state,
      subjects: userData.subjects,
      coins: userData.coins,
      xp: userData.xp,
      maxXp: userData.maxXp,
      level: userData.level,
      // Level, title and progress through it (see gamification/levels.ts).
      levelInfo: userData.levelInfo,
      streak: userData.streak,
      longestStreak: userData.longestStreak,
      badges: userData.badges,
      certificates: userData.certificates,
      questionsAnswered: userData.questionsAnswered,
      accuracy: userData.accuracy,
      timeSpent: userData.timeSpent,
    };
  }

  // GET /users/me/safeguarding
  @Get('me/safeguarding')
  async safeguardingStatus(@CurrentUser() user: any) {
    return this.safeguarding.status(user.sub);
  }

  // PUT /users/me/guardian - a parent or guardian's agreement
  @Put('me/guardian')
  async setGuardian(@CurrentUser() user: any, @Body() dto: GuardianConsentDto) {
    return this.safeguarding.setGuardian(user.sub, dto);
  }

  // POST /users/me/accept-policy
  @Post('me/accept-policy')
  @HttpCode(HttpStatus.OK)
  async acceptPolicy(@CurrentUser() user: any, @Body() dto: AcceptPolicyDto) {
    return this.safeguarding.acceptPolicy(user.sub, dto.version);
  }

  // GET /users/me/export - a copy of everything held about the student
  @Get('me/export')
  async exportData(@CurrentUser() user: any) {
    return this.safeguarding.exportData(user.sub);
  }

  // DELETE /users/me
  @Delete('me')
  async deleteAccount(@CurrentUser() user: any) {
    return this.users.deleteAccount(user.sub);
  }

  // PATCH /users/change-password
  @Patch('change-password')
  async changePassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto) {
    return this.users.changePassword(user.sub, dto.currentPassword, dto.newPassword, dto.refreshToken);
  }

  // GET /users/daily-summary
  @Get('daily-summary')
  async getDailySummary(@CurrentUser() user: any) {
    return this.activity.getDailySummary(user.sub);
  }

  // GET /users/leaderboard?period=all|weekly|monthly
  @Get('leaderboard')
  async getLeaderboard(
    @CurrentUser() user: any,
    @Query('period') period?: 'all' | 'weekly' | 'monthly',
  ) {
    return this.leaderboards.legacy(user.sub, period ?? 'all', 20);
  }

  // GET /users/search?q=ola&subjectId=math — find a student to challenge,
  // by username or name prefix. Excludes the caller and (when subjectId
  // is given) anyone already in an open challenge with the caller for
  // that subject.
  @Get('search')
  async search(
    @CurrentUser() user: any,
    @Query('q') q: string,
    @Query('subjectId') subjectId?: string,
  ) {
    return this.users.searchStudents(user.sub, q ?? '', subjectId);
  }

  // GET /users/subject-progress
  @Get('subject-progress')
  async getSubjectProgress(@CurrentUser() user: any) {
    return this.users.getSubjectProgress(user.sub);
  }

  // PATCH /users/profile
  @Patch('profile')
  async updateProfile(
    @CurrentUser() user: any,
    @Body() dto: UpdateProfileDto,
  ) {
    await this.users.updateProfile(user.sub, dto);
    return {
      success: true,
      message: 'Profile updated successfully',
    };
  }

  // POST /users/claim-bonus
  @Post('claim-bonus')
  async claimBonus(@CurrentUser() user: any) {
    const result = await this.users.claimWelcomeBonus(user.sub);
    return {
      bonusCoins: result.bonusCoins,
      bonusXp: result.bonusXp,
      alreadyClaimed: result.alreadyClaimed,
      message: result.alreadyClaimed ? 'Bonus already claimed' : 'Bonus claimed successfully',
    };
  }

  // POST /users/complete-challenge
  @Post('complete-challenge')
  async completeChallenge(@CurrentUser() user: any, @Body() dto: CompleteChallengeDto) {
    const result = await this.users.completeStarterChallenge(user.sub, dto.sessionId, dto.answers);
    return {
      earnedCoins: result.earnedCoins,
      earnedXp: result.earnedXp,
      questionsAnsweredInChallenge: result.questionsAnsweredInChallenge,
      correctAnswers: result.correctAnswers,
      nationalRank: result.nationalRank,
      stateRank: result.stateRank,
      message: 'Challenge completed!',
    };
  }
}
