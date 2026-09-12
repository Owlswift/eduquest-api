import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SubjectsService } from './subjects.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('subjects')
@ApiBearerAuth('access-token')
@Controller('subjects')
@UseGuards(JwtAuthGuard)
export class SubjectsController {
  constructor(private subjects: SubjectsService) {}

  // GET /subjects
  @Get()
  @ApiOperation({ summary: 'List all subjects' })
  async getAll(@CurrentUser() user: any) {
    return this.subjects.findAll();
  }

  // POST /subjects/seed (for initial setup)
  @Post('seed')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Upsert the default subject list (safe to re-run)' })
  async seed() {
    return this.subjects.seedSubjects();
  }
}
