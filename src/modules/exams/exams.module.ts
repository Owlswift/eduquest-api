import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [ExamsController],
  providers: [ExamsService],
})
export class ExamsModule {}
