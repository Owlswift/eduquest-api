import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CompetitionSittingsService } from './competition-sittings.service';
import { CompetitionsController } from './competitions.controller';
import { CompetitionsService } from './competitions.service';
import { PrizesController } from './prizes.controller';
import { PrizesService } from './prizes.service';

// Global so the quiz and admin modules can use sittings and prizes without importing this module.
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [CompetitionsController, PrizesController],
  providers: [CompetitionsService, CompetitionSittingsService, PrizesService],
  exports: [CompetitionSittingsService, PrizesService],
})
export class CompetitionsModule {}
