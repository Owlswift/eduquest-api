import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { QuizModule } from './modules/quiz/quiz.module';
import { CurriculumModule } from './modules/curriculum/curriculum.module';
import { TutorModule } from './modules/tutor/tutor.module';
import { ActivityModule } from './modules/activity/activity.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ActivityModule,
    HealthModule,
    AuthModule,
    UsersModule,
    SubjectsModule,
    QuizModule,
    CurriculumModule,
    TutorModule,
  ],
})
export class AppModule {}
