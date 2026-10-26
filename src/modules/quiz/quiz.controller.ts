import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { QuizService } from './quiz.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClassLevel, UserRole } from '@prisma/client';
import { SubmitQuizDto } from './dto/submit-quiz.dto';
import { CheckAnswerDto } from './dto/check-answer.dto';

@ApiTags('quiz')
@ApiBearerAuth('access-token')
@Controller('quiz')
@UseGuards(JwtAuthGuard)
export class QuizController {
  constructor(private quiz: QuizService) {}

  // GET /quiz/questions?subjectId=math&count=10&classLevel=SS1
  @Get('questions')
  async getQuestions(
    @CurrentUser() user: any,
    @Query('subjectId') subjectId: string,
    @Query('count', new DefaultValuePipe(10), ParseIntPipe) count: number,
    @Query('classLevel') classLevel: ClassLevel = ClassLevel.SS1,
  ) {
    return this.quiz.getRandomQuestions(user.sub, subjectId, count, classLevel);
  }

  // GET /quiz/topics?subjectId=math&classLevel=SS1
  @Get('topics')
  async getTopics(
    @Query('subjectId') subjectId: string,
    @Query('classLevel') classLevel: ClassLevel = ClassLevel.SS1,
  ) {
    return this.quiz.getTopics(subjectId, classLevel);
  }

  // POST /quiz/questions/:id/check — locks in the answer for this question
  // of the student's session and reveals correctness, for screens that show
  // immediate per-question feedback. The first answer wins.
  @Post('questions/:id/check')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async checkAnswer(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: CheckAnswerDto,
  ) {
    return this.quiz.checkAnswer(user.sub, dto.sessionId, id, dto.selectedOptionId);
  }

  // POST /quiz/submit
  @Post('submit')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async submitResults(@CurrentUser() user: any, @Body() dto: SubmitQuizDto) {
    return this.quiz.submitQuizResults(user.sub, dto);
  }

  // POST /quiz/seed — run once to populate questions
  @Post('seed')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async seed() {
    return this.quiz.seedQuestions();
  }
}