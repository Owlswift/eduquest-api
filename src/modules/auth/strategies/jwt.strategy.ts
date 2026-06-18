import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../database/prisma.service';
import { AuthService } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  async validate(payload: { sub: string; email: string; jti: string }) {
    // Check if token has been blacklisted (logged out)
    const blacklisted = await this.authService.isTokenBlacklisted(payload.jti);
    if (blacklisted) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) throw new UnauthorizedException();

    // Attach the full payload (including jti) to the request via user
    return { ...user, tokenJti: payload.jti };
  }
}