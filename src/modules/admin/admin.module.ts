import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { QuizModule } from '../quiz/quiz.module';
import { AdminCompetitionResultsService } from './admin-competition-results.service';
import { AdminCompetitionsService } from './admin-competitions.service';
import { AdminContentController } from './admin-content.controller';
import { AdminQuestionsService } from './admin-questions.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminRewardsService } from './admin-rewards.service';
import { AuditModule } from './audit.module';

@Module({
  imports: [JwtModule.register({}), QuizModule, AuditModule],
  controllers: [AdminController, AdminContentController],
  providers: [AdminService, AdminQuestionsService, AdminCompetitionsService, AdminCompetitionResultsService, AdminRewardsService],
})
export class AdminModule {}
