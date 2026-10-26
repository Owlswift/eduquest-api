import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminService } from './admin.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ReasonDto } from './dto/competition-actions.dto';

@ApiTags('admin')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  // GET /admin/overview
  @Get('overview')
  @ApiOperation({ summary: 'Aggregate stats for the admin dashboard home page' })
  async overview() {
    return this.admin.overview();
  }

  // GET /admin/users?search=&page=&limit=
  @Get('users')
  @ApiOperation({ summary: 'Search/list students, paginated' })
  async listUsers(
    @Query('search') search?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.admin.listUsers(search, page, limit);
  }

  // GET /admin/users/:id
  @Get('users/:id')
  @ApiOperation({ summary: 'Full detail for one user' })
  async getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  // POST /admin/users/:id/guardian-consent/withdraw
  @Post('users/:id/guardian-consent/withdraw')
  @ApiOperation({ summary: "Withdraw a parent or guardian's agreement at their request" })
  async withdrawGuardian(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.admin.withdrawGuardianConsent(admin.sub, id, dto.reason);
  }

  // DELETE /admin/users/:id
  @Delete('users/:id')
  @ApiOperation({ summary: 'Erase a student account and everything it owns (for example on a parent or guardian request)' })
  async erase(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.admin.eraseStudent(admin.sub, id, dto.reason);
  }

  // PATCH /admin/users/:id/role
  @Patch('users/:id/role')
  @ApiOperation({ summary: 'Promote/demote a user - cannot change your own role' })
  async updateRole(
    @CurrentUser() admin: any,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.admin.updateUserRole(admin.sub, id, dto.role);
  }
}
