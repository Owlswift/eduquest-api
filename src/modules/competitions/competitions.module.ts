import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CompetitionsController } from './competitions.controller';
import { CompetitionsService } from './competitions.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [CompetitionsController],
  providers: [CompetitionsService],
})
export class CompetitionsModule {}
