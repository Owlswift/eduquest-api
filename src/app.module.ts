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
import { CompetitionsModule } from './modules/competitions/competitions.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { MailerModule } from './modules/mailer/mailer.module';
import { PushModule } from './modules/push/push.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MailerModule,
    PushModule,
    NotificationsModule,
    CertificatesModule,
    AdminModule,
    ActivityModule,
    HealthModule,
    AuthModule,
    UsersModule,
    SubjectsModule,
    QuizModule,
    CurriculumModule,
    TutorModule,
    CompetitionsModule,
    RewardsModule,
  ],
})
export class AppModule {}
