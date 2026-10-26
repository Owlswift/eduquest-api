import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CertificatesService } from './certificates.service';

/** Public: no login, so a school or sponsor can check a certificate. */
@ApiTags('certificates')
@Controller('certificates')
export class CertificatesVerifyController {
  constructor(private certificates: CertificatesService) {}

  // GET /certificates/verify/:code
  @Get('verify/:code')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Confirm a certificate is genuine from its verification code (no login)' })
  verify(@Param('code') code: string) {
    return this.certificates.verify(code);
  }
}
