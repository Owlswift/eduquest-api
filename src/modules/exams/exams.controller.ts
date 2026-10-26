import { Body, Controller, Get, Param, ParseIntPipe, DefaultValuePipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SaveExamAnswersDto, StartExamDto, SubmitExamDto } from './dto/exam.dto';
import { ExamsService } from './exams.service';

@ApiTags('exams')
@ApiBearerAuth('access-token')
@Controller('exams')
@UseGuards(JwtAuthGuard)
export class ExamsController {
  constructor(private exams: ExamsService) {}

  // POST /exams/start: begin a timed exam. The deadline is enforced on the server.
  @Post('start')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  start(@CurrentUser() user: any, @Body() dto: StartExamDto) {
    return this.exams.start(user.sub, dto);
  }

  // GET /exams/history
  @Get('history')
  history(@CurrentUser() user: any, @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number) {
    return this.exams.history(user.sub, limit);
  }

  // GET /exams/:id: resume while running; the result once it is over.
  @Get(':id')
  get(@CurrentUser() user: any, @Param('id') id: string) {
    return this.exams.get(user.sub, id);
  }

  // PUT /exams/:id/answers: autosave. Refused after the deadline.
  @Put(':id/answers')
  save(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: SaveExamAnswersDto) {
    return this.exams.saveAnswers(user.sub, id, dto.answers);
  }

  // POST /exams/:id/submit: finish and grade. Idempotent.
  @Post(':id/submit')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  submit(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: SubmitExamDto) {
    return this.exams.submit(user.sub, id, dto.answers ?? []);
  }

  // GET /exams/:id/review: every question with your answer, the right one and why.
  @Get(':id/review')
  review(@CurrentUser() user: any, @Param('id') id: string) {
    return this.exams.review(user.sub, id);
  }
}
