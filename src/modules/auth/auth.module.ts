import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RefreshTokensService } from './refresh-tokens.service';
import { GoogleTokenVerifier } from './strategies/google.strategy';

@Module({
  imports: [JwtModule.register({}), PassportModule],
  controllers: [AuthController],
  providers: [AuthService, RefreshTokensService, JwtStrategy, GoogleTokenVerifier],
  exports: [RefreshTokensService],
})
export class AuthModule {}