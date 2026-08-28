import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CurriculumController } from './curriculum.controller';
import { CurriculumService } from './curriculum.service';
import { PdfExtractionService } from './pdf-extraction.service';
import { LlmExtractionService } from './llm-extraction.service';
import { PrismaModule } from '../../database/prisma.module';

@Module({
  imports: [PrismaModule, JwtModule],
  controllers: [CurriculumController],
  providers: [CurriculumService, PdfExtractionService, LlmExtractionService],
  exports: [CurriculumService],
})
export class CurriculumModule {}
