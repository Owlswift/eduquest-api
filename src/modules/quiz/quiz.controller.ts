import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { QuizService } from './quiz.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClassLevel } from '@prisma/client';

@ApiTags('quiz')
@ApiBearerAuth('access-token')
@Controller('quiz')
@UseGuards(JwtAuthGuard)
export class QuizController {
  constructor(private quiz: QuizService) {}

  // GET /quiz/questions?subjectId=math&count=10&classLevel=SS1
  @Get('questions')
  async getQuestions(
    @Query('subjectId') subjectId: string,
    @Query('count', new DefaultValuePipe(10), ParseIntPipe) count: number,
    @Query('classLevel') classLevel: ClassLevel = ClassLevel.SS1,
  ) {
    return this.quiz.getRandomQuestions(subjectId, count, classLevel);
  }

  // POST /quiz/submit
  @Post('submit')
  async submitResults(
    @CurrentUser() user: any,
    @Body()
    dto: {
      subjectId: string;
      correctAnswers: number;
      totalQuestions: number;
      timeTaken: number;
    },
  ) {
    return this.quiz.submitQuizResults(user.sub, dto);
  }

  // POST /quiz/seed — run once to populate questions
  @Post('seed')
  async seed() {
    return this.quiz.seedQuestions();
  }
}