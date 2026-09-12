import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

function fakeContext(headers: Record<string, string>) {
  const request = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

describe('JwtAuthGuard', () => {
  let jwt: { verify: jest.Mock };
  let prisma: {
    blacklistedToken: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwt = { verify: jest.fn() };
    prisma = {
      blacklistedToken: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    guard = new JwtAuthGuard(jwt as any, prisma as any);
  });

  it('throws when no token is provided', async () => {
    await expect(guard.canActivate(fakeContext({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws for an invalid/expired signature', async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('bad signature');
    });
    await expect(
      guard.canActivate(fakeContext({ authorization: 'Bearer bad-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a blacklisted (logged-out) token even with a valid signature', async () => {
    jwt.verify.mockReturnValue({ sub: 'u1', email: 'a@b.com', jti: 'jti-1' });
    prisma.blacklistedToken.findUnique.mockResolvedValue({ tokenJti: 'jti-1' });

    await expect(
      guard.canActivate(fakeContext({ authorization: 'Bearer good-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a token whose user no longer exists (deleted account)", async () => {
    jwt.verify.mockReturnValue({ sub: 'ghost', email: 'a@b.com', jti: 'jti-1' });
    prisma.blacklistedToken.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(fakeContext({ authorization: 'Bearer good-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a valid, non-blacklisted token for an existing user', async () => {
    const payload = { sub: 'u1', email: 'a@b.com', jti: 'jti-1' };
    jwt.verify.mockReturnValue(payload);
    prisma.blacklistedToken.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

    const request: any = { headers: { authorization: 'Bearer good-token' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as any;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(payload);
  });
});
