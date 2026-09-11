import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CertificatesService } from './certificates.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('certificates')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('certificates')
export class CertificatesController {
  constructor(private certificates: CertificatesService) {}

  // GET /certificates
  @Get()
  @ApiOperation({ summary: 'List earned certificates, most recent first' })
  async list(@CurrentUser() user: any) {
    return this.certificates.list(user.sub);
  }
}
