import { Controller, Get, Param, StreamableFile, UseGuards } from '@nestjs/common';
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

  // GET /certificates/:id/pdf
  @Get(':id/pdf')
  @ApiOperation({ summary: 'Download one of your certificates as a PDF (owner only)' })
  async pdf(@CurrentUser() user: any, @Param('id') id: string) {
    const { filename, data } = await this.certificates.pdf(user.sub, id);
    return new StreamableFile(data, { type: 'application/pdf', disposition: `attachment; filename="${filename}"` });
  }
}
