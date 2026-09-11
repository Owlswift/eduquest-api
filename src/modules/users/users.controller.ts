import { Controller, Get, Patch, Post, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { UsersService } from './users.service';
import { ActivityService } from '../activity/activity.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CompleteChallengeDto } from './dto/complete-challenge.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private users: UsersService,
    private activity: ActivityService,
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
      streak: userData.streak,
      badges: userData.badges,
      certificates: userData.certificates,
      questionsAnswered: userData.questionsAnswered,
      accuracy: userData.accuracy,
      timeSpent: userData.timeSpent,
    };
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
    return this.users.getLeaderboard(user.sub, 20, period ?? 'all');
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
      message: 'Bonus claimed successfully',
    };
  }

  // POST /users/complete-challenge
  @Post('complete-challenge')
  async completeChallenge(@CurrentUser() user: any, @Body() dto: CompleteChallengeDto) {
    const result = await this.users.completeStarterChallenge(user.sub, dto.answers);
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
