import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';

const DAY = 86_400_000;
/** How long one refresh token lasts without being used. */
export const REFRESH_TTL_MS = 30 * DAY;
/** A login can be renewed for at most this long in total; after that, sign in again. */
export const FAMILY_MAX_MS = 90 * DAY;
/** A token used again this soon after it was rotated is two requests racing, not a thief. */
export const REUSE_GRACE_MS = 10_000;

export const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');
const hashOf = hashRefreshToken;

export interface IssuedRefresh {
  token: string;
  userId: string;
}

/**
 * Long-lived logins that renew the short-lived access token. Tokens are
 * random, stored only as a hash, and used once: every renewal hands out a
 * new one. Presenting a token that was already used (outside a short grace for
 * racing requests) means it was copied, so the whole login is revoked.
 */
@Injectable()
export class RefreshTokensService {
  constructor(private prisma: PrismaService) {}

  /** Starts a login, or continues one (`family`) with a fresh token. */
  async issue(userId: string, family?: { id: string; expiresAt: Date }, now = new Date()): Promise<IssuedRefresh> {
    const token = randomBytes(32).toString('base64url');
    const familyExpiresAt = family?.expiresAt ?? new Date(now.getTime() + FAMILY_MAX_MS);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId: family?.id ?? randomUUID(),
        tokenHash: hashOf(token),
        expiresAt: new Date(Math.min(now.getTime() + REFRESH_TTL_MS, familyExpiresAt.getTime())),
        familyExpiresAt,
      },
    });
    return { token, userId };
  }

  /** Spends `token` and returns its replacement. Throws 401 if it cannot be used. */
  async rotate(token: string, now = new Date()): Promise<IssuedRefresh> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashOf(token) } });
    if (!row) throw new UnauthorizedException('Invalid refresh token');

    if (row.revokedAt) {
      if (row.rotatedAt && now.getTime() - row.rotatedAt.getTime() < REUSE_GRACE_MS) {
        throw new UnauthorizedException('Refresh already in progress, retry in a moment');
      }
      await this.revokeFamily(row.familyId, now);
      throw new UnauthorizedException('Session ended, please sign in again');
    }
    if (row.expiresAt <= now || row.familyExpiresAt <= now) throw new UnauthorizedException('Session expired, please sign in again');

    // The conditional update decides which of two simultaneous requests wins.
    const next = await this.prisma.$transaction(async (tx) => {
      const gate = await tx.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now, rotatedAt: now } });
      if (gate.count === 0) return null;
      const fresh = randomBytes(32).toString('base64url');
      await tx.refreshToken.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: hashOf(fresh),
          expiresAt: new Date(Math.min(now.getTime() + REFRESH_TTL_MS, row.familyExpiresAt.getTime())),
          familyExpiresAt: row.familyExpiresAt,
        },
      });
      return fresh;
    });
    if (!next) throw new UnauthorizedException('Refresh already in progress, retry in a moment');
    return { token: next, userId: row.userId };
  }

  /** Ends the login `token` belongs to, if it is `userId`'s. Quietly does nothing otherwise. */
  async revokeLogin(userId: string, token: string, now = new Date()) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashOf(token) } });
    if (row && row.userId === userId) await this.revokeFamily(row.familyId, now);
  }

  /** Ends every login of a user (password change or reset). */
  async revokeAllFor(userId: string, now = new Date()) {
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  }

  private async revokeFamily(familyId: string, now: Date) {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }
}
