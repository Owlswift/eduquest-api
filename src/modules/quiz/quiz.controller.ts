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
    @Query('subjectId') subjectId: string,
    @Query('count', new DefaultValuePipe(10), ParseIntPipe) count: number,
    @Query('classLevel') classLevel: ClassLevel = ClassLevel.SS1,
  ) {
    return this.quiz.getRandomQuestions(subjectId, count, classLevel);
  }

  // GET /quiz/topics?subjectId=math&classLevel=SS1
  @Get('topics')
  async getTopics(
    @Query('subjectId') subjectId: string,
    @Query('classLevel') classLevel: ClassLevel = ClassLevel.SS1,
  ) {
    return this.quiz.getTopics(subjectId, classLevel);
  }

  // POST /quiz/questions/:id/check — reveal correctness after answering,
  // for screens that show immediate per-question feedback. Doesn't affect
  // scoring (submit still grades independently).
  @Post('questions/:id/check')
  async checkAnswer(@Param('id') id: string, @Body() dto: CheckAnswerDto) {
    return this.quiz.checkAnswer(id, dto.selectedOptionId);
  }

  // POST /quiz/submit
  @Post('submit')
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