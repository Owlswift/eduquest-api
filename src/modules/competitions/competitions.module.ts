import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CompetitionSittingsService } from './competition-sittings.service';
import { CompetitionsController } from './competitions.controller';
import { CompetitionsService } from './competitions.service';

// Global so the quiz service can record a graded sitting without importing this module.
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [CompetitionsController],
  providers: [CompetitionsService, CompetitionSittingsService],
  exports: [CompetitionSittingsService],
})
export class CompetitionsModule {}
