import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SubjectsService } from './subjects.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('subjects')
@UseGuards(JwtAuthGuard)
export class SubjectsController {
  constructor(private subjects: SubjectsService) {}

  // GET /subjects
  @Get()
  async getAll(@CurrentUser() user: any) {
    return this.subjects.findAll();
  }

  // POST /subjects/seed (for initial setup)
  @Post('seed')
  async seed() {
    return this.subjects.seedSubjects();
  }
}