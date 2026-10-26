import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../admin/audit.module';
import { AdminSponsorsController, SponsorsPublicController } from './sponsors.controller';
import { SponsorsService } from './sponsors.service';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [SponsorsPublicController, AdminSponsorsController],
  providers: [SponsorsService],
})
export class SponsorsModule {}
