import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CertificatesController } from './certificates.controller';
import { CertificatesVerifyController } from './certificates-verify.controller';
import { CertificatesService } from './certificates.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [CertificatesController, CertificatesVerifyController],
  providers: [CertificatesService],
  exports: [CertificatesService],
})
export class CertificatesModule {}
