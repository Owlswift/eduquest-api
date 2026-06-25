import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { GoogleTokenVerifier } from './strategies/google.strategy';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private googleVerifier: GoogleTokenVerifier,
  ) {}

  // ─── Email/Password Register ────────────────────────────────────────────────

  async register(dto: any) {
    const hash = await argon2.hash(dto.password);
    const baseUsername = dto.email.split('@')[0].toLowerCase().trim();
    const username = await this._uniqueUsername(baseUsername);

    try {
      const user = await this.prisma.user.create({
        data: {
          fullName: dto.name.toLowerCase().trim(),
          username,
          email: dto.email.toLowerCase().trim(),
          passwordHash: hash,
          phone: dto.phone?.toLowerCase().trim() || null,
          country: dto.country?.toLowerCase().trim() || null,
          state: dto.state?.toLowerCase().trim() || null,
          institution: dto.institution?.toLowerCase().trim() || null,
          age: dto.age?.toLowerCase().trim() || null,
          interests: dto.interests ? JSON.stringify(dto.interests) : null,
        },
      });

      return this.signToken(user.id, user.email);
    } catch (error: any) {
      // Handle unique constraint violations gracefully
      if (error.code === 'P2002') {
        const constraint = error.meta?.constraint?.fields?.[0];
        
        if (constraint === 'email') {
          throw new ConflictException('An account with this email already exists');
        } else if (constraint === 'phone') {
          throw new ConflictException('An account with this phone number already exists');
        } else if (constraint === 'username') {
          // This shouldn't happen with _uniqueUsername, but handle it just in case
          throw new ConflictException('An account with this username already exists');
        }
      }
      
      // Re-throw other errors
      throw error;
    }
  }

  // ─── Email/Password Login ───────────────────────────────────────────────────

  async login(dto: any) {
    const loginIdentifier = dto.email.toLowerCase().trim();
    
    // Try to find user by email or username
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: loginIdentifier },
          { username: loginIdentifier },
        ],
      },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    // Google-only accounts have no password
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account uses Google Sign-In. Please sign in with Google.',
      );
    }

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) throw new UnauthorizedException('Invalid credentials');

    return this.signToken(user.id, user.email);
  }

  // ─── Google Sign-In ─────────────────────────────────────────────────────────

  async googleLogin(idToken: string) {
    // 1. Verify the ID token with Google
    const googleUser = await this.googleVerifier.verify(idToken);

    // 2. Try to find existing user by googleId first, then by email
    let user = await this.prisma.user.findUnique({
      where: { googleId: googleUser.googleId },
    });

    if (!user) {
      // Check if email already exists (email/password account)
      const existingEmailUser = await this.prisma.user.findUnique({
        where: { email: googleUser.email.toLowerCase() },
      });

      if (existingEmailUser) {
        // Link Google to existing email account
        user = await this.prisma.user.update({
          where: { id: existingEmailUser.id },
          data: {
            googleId: googleUser.googleId,
            avatarUrl: googleUser.avatarUrl,
          },
        });
      } else {
        // Create brand new Google user
        const baseUsername = googleUser.email.split('@')[0].toLowerCase().trim();
        const username = await this._uniqueUsername(baseUsername);

        user = await this.prisma.user.create({
          data: {
            fullName: googleUser.fullName,
            username,
            email: googleUser.email.toLowerCase(),
            passwordHash: null, // Google users have no password
            googleId: googleUser.googleId,
            avatarUrl: googleUser.avatarUrl,
          },
        });
      }
    } else {
      // Update avatar in case it changed
      if (googleUser.avatarUrl && user.avatarUrl !== googleUser.avatarUrl) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { avatarUrl: googleUser.avatarUrl },
        });
      }
    }

    return this.signToken(user.id, user.email);
  }

  // ─── Logout ─────────────────────────────────────────────────────────────────

  async logout(userId: string, tokenJti: string) {
    await this.prisma.blacklistedToken.create({
      data: {
        tokenJti,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return { message: 'Logged out successfully' };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

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

  // Generate a unique username by appending a number if needed
  private async _uniqueUsername(base: string): Promise<string> {
    let username = base;
    let counter = 1;

    while (true) {
      const existing = await this.prisma.user.findUnique({
        where: { username },
      });
      if (!existing) return username;
      username = `${base}${counter}`;
      counter++;
    }
  }
}