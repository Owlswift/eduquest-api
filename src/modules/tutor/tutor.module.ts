import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TutorController } from './tutor.controller';
import { TutorService } from './tutor.service';
import { TutorLlmService } from './tutor-llm.service';
import { PrismaModule } from '../../database/prisma.module';
import { VoiceModule } from '../voice/voice.module';
import { ImageModule } from '../image/image.module';

@Module({
  imports: [PrismaModule, JwtModule, VoiceModule, ImageModule],
  controllers: [TutorController],
  providers: [TutorService, TutorLlmService],
  exports: [TutorService],
})
export class TutorModule {}
