import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaService } from '../../database/prisma.service';
import { LeaderboardsModule } from '../leaderboards/leaderboards.module';
import { QuizModule } from '../quiz/quiz.module';

@Module({
  imports: [JwtModule.register({}), QuizModule, LeaderboardsModule],
  controllers: [UsersController],
  providers: [UsersService, PrismaService],
  exports: [UsersService],
})
export class UsersModule {}
