/**
 * Refresh tokens against a REAL database: rotation, theft detection, racing
 * refreshes, expiry, logout and password changes.
 */
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../src/modules/auth/auth.service';
import { hashRefreshToken, REFRESH_TTL_MS, REUSE_GRACE_MS, RefreshTokensService } from '../src/modules/auth/refresh-tokens.service';
import { UsersService } from '../src/modules/users/users.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('refresh tokens (real database)', () => {
  let prisma: PrismaClient;
  let tokens: RefreshTokensService;
  let auth: AuthService;
  const jwt = new JwtService({});
  const tag = `rt${Date.now()}`;
  let n = 0;
  const makeUser = async () => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: 'Rita Token', username: id, email: `${id}@t.test`, classLevel: 'SS2' } });
    return { id, email: `${id}@t.test` };
  };
  const alive = (userId: string) => prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
    tokens = new RefreshTokensService(prisma as any);
    auth = new AuthService(prisma as any, jwt, {} as any, {} as any, tokens);
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.$disconnect();
  });

  it('gives a login a short-lived access token and a refresh token that renews it', async () => {
    const u = await makeUser();
    const login = await auth.signToken(u.id, u.email);
    expect(login.expiresIn).toBe(3600);
    const decoded = jwt.verify(login.accessToken, { secret: 'test-secret' });
    expect(decoded.exp - decoded.iat).toBe(3600);

    const renewed = await auth.refresh(login.refreshToken);
    expect(renewed.refreshToken).not.toBe(login.refreshToken);
    expect(jwt.verify(renewed.accessToken, { secret: 'test-secret' }).sub).toBe(u.id);
    expect(await alive(u.id)).toBe(1); // the old one is spent, the new one live
  });

  it('stores only a hash of the token', async () => {
    const u = await makeUser();
    const { token } = await tokens.issue(u.id);
    const rows = await prisma.refreshToken.findMany({ where: { userId: u.id } });
    expect(rows[0].tokenHash).toBe(hashRefreshToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('treats a spent token used again as theft and ends the whole login', async () => {
    const u = await makeUser();
    const first = await tokens.issue(u.id);
    const second = await tokens.rotate(first.token, new Date(Date.now() - 60_000)); // rotated a minute ago
    await expect(tokens.rotate(first.token)).rejects.toThrow(/sign in again/);
    // The thief's replay also killed the honest holder's newer token.
    await expect(tokens.rotate(second.token)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await alive(u.id)).toBe(0);
  });

  it('lets a racing duplicate request fail quietly without ending the login', async () => {
    const u = await makeUser();
    const first = await tokens.issue(u.id);
    const second = await tokens.rotate(first.token);
    await expect(tokens.rotate(first.token, new Date(Date.now() + REUSE_GRACE_MS / 2))).rejects.toThrow(/in progress/);
    await expect(tokens.rotate(second.token)).resolves.toBeDefined(); // still good
  });

  it('lets exactly one of several simultaneous refreshes win', async () => {
    const u = await makeUser();
    const { token } = await tokens.issue(u.id);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => tokens.rotate(token)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await alive(u.id)).toBe(1);
  });

  it('refuses unknown, expired and over-age tokens', async () => {
    const u = await makeUser();
    await expect(tokens.rotate('nonsense')).rejects.toThrow(/Invalid/);
    const { token } = await tokens.issue(u.id);
    await expect(tokens.rotate(token, new Date(Date.now() + REFRESH_TTL_MS + 1000))).rejects.toThrow(/expired/);
    // A login cannot be renewed forever: the family cap shortens each renewal.
    const old = await tokens.issue(u.id, { id: 'fam-old', expiresAt: new Date(Date.now() + 5 * 86_400_000) });
    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashRefreshToken(old.token) } });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 86_400_000);
  });

  it('logout ends only that device; with no token it ends every device', async () => {
    const u = await makeUser();
    const phone = await auth.signToken(u.id, u.email);
    const tablet = await auth.signToken(u.id, u.email);
    await auth.logout(u.id, 'jti-a', phone.refreshToken);
    await expect(auth.refresh(phone.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refresh(tablet.refreshToken)).resolves.toBeDefined();
    await auth.logout(u.id, 'jti-b');
    expect(await alive(u.id)).toBe(0);
    await prisma.blacklistedToken.deleteMany({ where: { tokenJti: { in: ['jti-a', 'jti-b'] } } });
  });

  it("will not let one user end another's login", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const theirs = await auth.signToken(b.id, b.email);
    await tokens.revokeLogin(a.id, theirs.refreshToken);
    expect(await alive(b.id)).toBe(1);
  });

  it('a password change signs out other devices but not the one that changed it', async () => {
    const u = await makeUser();
    const mine = await auth.signToken(u.id, u.email);
    const other = await auth.signToken(u.id, u.email);
    const hash = await argon2.hash('oldpass1');
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: hash } });
    const users = new UsersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await users.changePassword(u.id, 'oldpass1', 'newpass1', mine.refreshToken);
    await expect(auth.refresh(other.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refresh(mine.refreshToken)).resolves.toBeDefined();
  });

  it('a deleted account takes its logins with it', async () => {
    const u = await makeUser();
    const { token } = await tokens.issue(u.id);
    await prisma.user.delete({ where: { id: u.id } });
    await expect(tokens.rotate(token)).rejects.toThrow(/Invalid/);
  });
});
