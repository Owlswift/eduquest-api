import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [CertificatesController],
  providers: [CertificatesService],
  exports: [CertificatesService],
})
export class CertificatesModule {}
