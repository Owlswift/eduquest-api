import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './database/prisma.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { QuizModule } from './modules/quiz/quiz.module';
import { CurriculumModule } from './modules/curriculum/curriculum.module';
import { TutorModule } from './modules/tutor/tutor.module';
import { ActivityModule } from './modules/activity/activity.module';
import { CompetitionsModule } from './modules/competitions/competitions.module';
import { ChallengesModule } from './modules/challenges/challenges.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { MailerModule } from './modules/mailer/mailer.module';
import { PushModule } from './modules/push/push.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Default for every route: 120 requests/min per client IP. Sensitive
    // routes (auth, quiz submit) tighten it with @Throttle.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    LedgerModule,
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
    ChallengesModule,
    RewardsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
