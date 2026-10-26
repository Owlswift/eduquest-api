import { Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClassLevel, ExamType, QuestionStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminCompetitionsService } from './admin-competitions.service';
import { AdminQuestionsService } from './admin-questions.service';
import { CreateCompetitionDto, UpdateCompetitionDto } from './dto/competition.dto';
import { CreateQuestionDto, SetStatusDto, UpdateQuestionDto } from './dto/question.dto';

@ApiTags('admin')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminContentController {
  constructor(
    private questions: AdminQuestionsService,
    private competitions: AdminCompetitionsService,
  ) {}

  // ─── Question bank ──────────────────────────────────────────────────────────

  @Get('questions')
  @ApiOperation({ summary: 'Search the question bank with performance stats and quality flags' })
  listQuestions(
    @Query('subjectId') subjectId?: string,
    @Query('classLevel') classLevel?: ClassLevel,
    @Query('topic') topic?: string,
    @Query('status') status?: QuestionStatus,
    @Query('examType') examType?: ExamType,
    @Query('q') q?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize = 25,
  ) {
    return this.questions.list({ subjectId, classLevel, topic, status, examType, q, page, pageSize });
  }

  @Get('questions/:id')
  getQuestion(@Param('id') id: string) {
    return this.questions.get(id);
  }

  @Post('questions')
  @ApiOperation({ summary: 'Create a question (a draft unless status says otherwise)' })
  createQuestion(@CurrentUser() admin: any, @Body() dto: CreateQuestionDto) {
    return this.questions.create(admin.sub, dto);
  }

  @Patch('questions/:id')
  @ApiOperation({ summary: 'Edit a question; send options and correctIndex together to change the answers' })
  updateQuestion(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    return this.questions.update(admin.sub, id, dto);
  }

  @Patch('questions/:id/status')
  @ApiOperation({ summary: 'Publish, retire or return to draft' })
  setQuestionStatus(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.questions.setStatus(admin.sub, id, dto.status);
  }

  @Delete('questions/:id')
  @ApiOperation({ summary: 'Delete an unused draft (retire anything else)' })
  deleteQuestion(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.questions.remove(admin.sub, id);
  }

  // ─── Competitions ───────────────────────────────────────────────────────────

  @Get('competitions')
  listCompetitions() {
    return this.competitions.list();
  }

  @Get('competitions/:id')
  getCompetition(@Param('id') id: string) {
    return this.competitions.get(id);
  }

  @Post('competitions')
  createCompetition(@CurrentUser() admin: any, @Body() dto: CreateCompetitionDto) {
    return this.competitions.create(admin.sub, dto);
  }

  @Patch('competitions/:id')
  @ApiOperation({ summary: 'Edit a competition; dates are locked once it has started' })
  updateCompetition(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: UpdateCompetitionDto) {
    return this.competitions.update(admin.sub, id, dto);
  }

  @Delete('competitions/:id')
  @ApiOperation({ summary: 'Delete a competition nobody has joined' })
  deleteCompetition(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.competitions.remove(admin.sub, id);
  }
}
