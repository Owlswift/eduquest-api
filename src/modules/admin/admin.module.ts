import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { QuizModule } from '../quiz/quiz.module';
import { AdminCompetitionResultsService } from './admin-competition-results.service';
import { AdminCompetitionsService } from './admin-competitions.service';
import { AdminContentController } from './admin-content.controller';
import { AdminQuestionsService } from './admin-questions.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditService } from './audit.service';

@Module({
  imports: [JwtModule.register({}), QuizModule],
  controllers: [AdminController, AdminContentController],
  providers: [AdminService, AdminQuestionsService, AdminCompetitionsService, AdminCompetitionResultsService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
