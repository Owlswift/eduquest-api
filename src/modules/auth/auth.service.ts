import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RefreshTokensService } from './refresh-tokens.service';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { GoogleTokenVerifier } from './strategies/google.strategy';
import { MailerService } from '../mailer/mailer.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private static readonly OTP_TTL_MINUTES = 10;
  private static readonly OTP_MAX_ATTEMPTS = 5;
  private static readonly OTP_RESEND_COOLDOWN_SECONDS = 60;

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private googleVerifier: GoogleTokenVerifier,
    private mailer: MailerService,
    private refreshTokens: RefreshTokensService,
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
          state: dto.state ?? null, // already canonical (see RegisterDto)
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

  async logout(userId: string, tokenJti: string, refreshToken?: string) {
    await this.prisma.blacklistedToken.create({
      data: {
        tokenJti,
        // Long enough to outlast any access token issued before the TTL was shortened (7 days).
        expiresAt: new Date(Date.now() + Math.max(AuthService.accessTtlSeconds() * 1000, 7 * 24 * 60 * 60 * 1000)),
      },
    });
    // End this device's login; a client that sent no refresh token (older app) ends them all.
    if (refreshToken) await this.refreshTokens.revokeLogin(userId, refreshToken);
    else await this.refreshTokens.revokeAllFor(userId);
    return { message: 'Logged out successfully' };
  }

  // ─── Forgot password (send OTP) ──────────────────────────────────────────────

  /** Always responds the same way whether or not the email exists, so the
   *  endpoint can't be used to enumerate registered accounts. Only
   *  actually creates/sends a code when the account exists. */
  async forgotPassword(email: string) {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (user) {
      const recent = await this.prisma.passwordResetOtp.findFirst({
        where: {
          userId: user.id,
          consumedAt: null,
          createdAt: {
            gt: new Date(Date.now() - AuthService.OTP_RESEND_COOLDOWN_SECONDS * 1000),
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!recent) {
        const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
        const codeHash = await argon2.hash(code);

        await this.prisma.passwordResetOtp.create({
          data: {
            userId: user.id,
            codeHash,
            expiresAt: new Date(Date.now() + AuthService.OTP_TTL_MINUTES * 60 * 1000),
          },
        });

        // A delivery failure (bad provider config, rate limit, etc.) is our
        // problem, not something to expose to the caller - the response
        // must stay identical either way so this endpoint can't be used to
        // probe for registered emails or provider outages.
        try {
          await this.mailer.send(
            user.email,
            'Your EduQuest password reset code',
            `<p>Hi ${this.firstName(user.fullName)},</p>` +
              `<p>Your password reset code is:</p>` +
              `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
              `<p>This code expires in ${AuthService.OTP_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.</p>`,
          );
        } catch (err) {
          this.logger.error(`Failed to send password reset email to ${user.email}`, err as Error);
        }
      }
    }

    return { message: 'If that email is registered, a reset code has been sent.' };
  }

  // ─── Verify OTP → short-lived reset token ────────────────────────────────────

  async verifyOtp(email: string, code: string) {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    // Same invalid-code error whether the email exists or the code is
    // wrong - don't leak which one failed.
    const invalid = () => new BadRequestException('Invalid or expired code');
    if (!user) throw invalid();

    const otp = await this.prisma.passwordResetOtp.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw invalid();
    if (otp.attempts >= AuthService.OTP_MAX_ATTEMPTS) throw invalid();

    const matches = await argon2.verify(otp.codeHash, code);
    if (!matches) {
      await this.prisma.passwordResetOtp.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalid();
    }

    await this.prisma.passwordResetOtp.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    const resetToken = await this.jwt.signAsync(
      { sub: user.id, purpose: 'password_reset' },
      { secret: process.env.JWT_SECRET, expiresIn: '10m' },
    );
    return { resetToken };
  }

  // ─── Reset password (using the token from verifyOtp) ─────────────────────────

  async resetPassword(resetToken: string, newPassword: string) {
    let payload: { sub: string; purpose: string };
    try {
      payload = await this.jwt.verifyAsync(resetToken, { secret: process.env.JWT_SECRET });
    } catch {
      throw new BadRequestException('Invalid or expired reset session - please start again');
    }
    if (payload.purpose !== 'password_reset') {
      throw new BadRequestException('Invalid or expired reset session - please start again');
    }

    const hash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: payload.sub },
      data: { passwordHash: hash },
    });
    // Whoever knew the old password (or stole a session) must sign in again:
    // renewals stop and every access token issued so far is refused.
    await this.refreshTokens.revokeAllFor(payload.sub);
    await this.prisma.user.update({ where: { id: payload.sub }, data: { tokensValidFrom: new Date() } });

    return { message: 'Password reset successfully' };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private firstName(fullName: string): string {
    const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
    if (!first) return 'there';
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const token = await this.prisma.blacklistedToken.findUnique({
      where: { tokenJti: jti },
    });
    return !!token;
  }

  /** Seconds an access token lives: 30 days unless ACCESS_TOKEN_TTL_SECONDS says otherwise. A copied token is cut off by logout, or by a password change (`tokensValidFrom`). */
  static accessTtlSeconds(): number {
    const n = Number(process.env.ACCESS_TOKEN_TTL_SECONDS);
    return Number.isFinite(n) && n >= 60 ? Math.floor(n) : 30 * 24 * 3600;
  }

  /** A new login: an access token plus the refresh token that renews it. */
  async signToken(userId: string, email: string) {
    return this.session(userId, email, await this.refreshTokens.issue(userId));
  }

  /** Trades a refresh token for a new access token and a new refresh token. */
  async refresh(refreshToken: string) {
    const next = await this.refreshTokens.rotate(refreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: next.userId }, select: { id: true, email: true } });
    if (!user) throw new UnauthorizedException('Account no longer exists');
    return this.session(user.id, user.email, next);
  }

  private async session(userId: string, email: string, refresh: { token: string }) {
    const jti = crypto.randomUUID();
    const expiresIn = AuthService.accessTtlSeconds();
    return {
      accessToken: await this.jwt.signAsync({ sub: userId, email, jti }, { secret: process.env.JWT_SECRET, expiresIn }),
      refreshToken: refresh.token,
      expiresIn,
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