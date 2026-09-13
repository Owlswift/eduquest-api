import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ChallengesService } from './challenges.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import { RespondChallengeDto } from './dto/respond-challenge.dto';
import { SubmitChallengeAnswersDto } from './dto/submit-challenge-answers.dto';

@ApiTags('challenges')
@ApiBearerAuth('access-token')
@Controller('challenges')
@UseGuards(JwtAuthGuard)
export class ChallengesController {
  constructor(private challenges: ChallengesService) {}

  // POST /challenges
  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateChallengeDto) {
    return this.challenges.create(user.sub, dto);
  }

  // GET /challenges?status=PENDING|ACTIVE|COMPLETED|DECLINED
  @Get()
  list(@CurrentUser() user: any, @Query('status') status?: string) {
    return this.challenges.list(user.sub, status);
  }

  // GET /challenges/suggestions?subjectId=math - must be registered
  // before GET /challenges/:id, or Nest would match "suggestions" as an
  // :id instead.
  @Get('suggestions')
  suggestOpponents(@CurrentUser() user: any, @Query('subjectId') subjectId: string) {
    return this.challenges.suggestOpponents(user.sub, subjectId);
  }

  // GET /challenges/:id
  @Get(':id')
  getOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.challenges.getOne(user.sub, id);
  }

  // POST /challenges/:id/respond
  @Post(':id/respond')
  respond(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: RespondChallengeDto) {
    return this.challenges.respond(user.sub, id, dto.topics);
  }

  // POST /challenges/:id/decline
  @Post(':id/decline')
  decline(@CurrentUser() user: any, @Param('id') id: string) {
    return this.challenges.decline(user.sub, id);
  }

  // GET /challenges/:id/questions
  @Get(':id/questions')
  getQuestions(@CurrentUser() user: any, @Param('id') id: string) {
    return this.challenges.getQuestions(user.sub, id);
  }

  // POST /challenges/:id/answers
  @Post(':id/answers')
  submitAnswers(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: SubmitChallengeAnswersDto,
  ) {
    return this.challenges.submitAnswers(user.sub, id, dto.answers);
  }

  // GET /challenges/:id/results
  @Get(':id/results')
  getResults(@CurrentUser() user: any, @Param('id') id: string) {
    return this.challenges.getResults(user.sub, id);
  }
}
