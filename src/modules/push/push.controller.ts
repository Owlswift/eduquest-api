import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PushService } from './push.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RegisterTokenDto } from './dto/register-token.dto';

@ApiTags('push')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('push')
export class PushController {
  constructor(private push: PushService) {}

  // POST /push/register-token
  @Post('register-token')
  @ApiOperation({ summary: 'Register this device for push notifications' })
  async registerToken(@CurrentUser() user: any, @Body() dto: RegisterTokenDto) {
    return this.push.registerToken(user.sub, dto.token, dto.platform);
  }

  // DELETE /push/register-token/:token
  @Delete('register-token/:token')
  @ApiOperation({ summary: 'Unregister a device (e.g. on logout)' })
  async unregisterToken(@Param('token') token: string) {
    return this.push.unregisterToken(token);
  }
}
