import { Body, Controller, Get, Patch, Post, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { UpdatePreferencesDto } from './dto/preferences.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  // GET /notifications
  @Get()
  @ApiOperation({ summary: 'List notifications, most recent first' })
  async list(@CurrentUser() user: any) {
    return this.notifications.list(user.sub);
  }

  // GET /notifications/preferences
  @Get('preferences')
  @ApiOperation({ summary: 'What I want to be notified about (prize and reward messages are always sent)' })
  async preferences(@CurrentUser() user: any) {
    const prefs = await this.notifications.preferencesFor(user.sub);
    return { ...prefs, alwaysOn: ['Reward and prize updates'] };
  }

  // PATCH /notifications/preferences
  @Patch('preferences')
  @ApiOperation({ summary: 'Switch notification categories or push on and off' })
  async updatePreferences(@CurrentUser() user: any, @Body() dto: UpdatePreferencesDto) {
    const prefs = await this.notifications.updatePreferences(user.sub, dto);
    return { ...prefs, alwaysOn: ['Reward and prize updates'] };
  }

  // GET /notifications/unread-count
  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notification count, for the bell badge' })
  async unreadCount(@CurrentUser() user: any) {
    return this.notifications.unreadCount(user.sub);
  }

  // POST /notifications/read-all
  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications read' })
  async markAllRead(@CurrentUser() user: any) {
    return this.notifications.markAllRead(user.sub);
  }

  // POST /notifications/:id/read
  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  async markRead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.notifications.markRead(user.sub, id);
  }
}
