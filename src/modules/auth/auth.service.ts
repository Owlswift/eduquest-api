import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async register(dto: any) {
    const hash = await argon2.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        fullName: dto.name.toLowerCase().trim(),
        username: dto.email.split('@')[0].toLowerCase().trim(),
        email: dto.email.toLowerCase().trim(),
        passwordHash: hash,
        phone: dto.phone?.toLowerCase().trim() || null,
      },
    });

    return this.signToken(user.id, user.email);
  }

  async login(dto: any) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const passwordValid = await argon2.verify(
      user.passwordHash,
      dto.password,
    );

    if (!passwordValid)
      throw new UnauthorizedException('Invalid credentials');

    return this.signToken(user.id, user.email);
  }

  async logout(userId: string, tokenJti: string) {
    // Store the token JTI in the blacklist so it can't be reused
    await this.prisma.blacklistedToken.create({
      data: {
        tokenJti,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days (matches token expiry)
      },
    });

    return { message: 'Logged out successfully' };
  }

  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const token = await this.prisma.blacklistedToken.findUnique({
      where: { tokenJti: jti },
    });
    return !!token;
  }

  async signToken(userId: string, email: string) {
    const jti = crypto.randomUUID();
    const payload = { sub: userId, email, jti };

    return {
      accessToken: await this.jwt.signAsync(payload, {
        secret: process.env.JWT_SECRET,
        expiresIn: '7d',
      }),
    };
  }
}