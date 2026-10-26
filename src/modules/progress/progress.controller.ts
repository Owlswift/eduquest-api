import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AttemptsService } from './attempts.service';

@ApiTags('progress')
@ApiBearerAuth('access-token')
@Controller('progress')
@UseGuards(JwtAuthGuard)
export class ProgressController {
  constructor(private attempts: AttemptsService) {}

  // GET /progress/topics?subjectId=: accuracy per topic from the student's own answers.
  @Get('topics')
  async topics(@CurrentUser() user: any, @Query('subjectId') subjectId?: string) {
    return this.attempts.topicStats(user.sub, { subjectId });
  }

  // GET /progress/weak-topics?subjectId=: topics with enough evidence and low accuracy.
  @Get('weak-topics')
  async weak(@CurrentUser() user: any, @Query('subjectId') subjectId?: string) {
    return this.attempts.weakTopics(user.sub, { subjectId });
  }
}
