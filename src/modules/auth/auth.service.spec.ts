import { BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

describe('AuthService password reset flow', () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    passwordResetOtp: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let mailer: { send: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      passwordResetOtp: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    jwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    mailer = { send: jest.fn() };
    service = new AuthService(prisma as any, jwt as any, {} as any, mailer as any);
  });

  afterEach(() => jest.useRealTimers());

  describe('forgotPassword', () => {
    it('creates an OTP and emails it when the account exists', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'ola@x.com',
        fullName: 'ola law',
      });
      prisma.passwordResetOtp.findFirst.mockResolvedValue(null); // no recent code
      prisma.passwordResetOtp.create.mockResolvedValue({});

      const result = await service.forgotPassword('ola@x.com');

      expect(prisma.passwordResetOtp.create).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send.mock.calls[0][0]).toBe('ola@x.com');
      expect(result.message).toMatch(/reset code has been sent/);
    });

    it('responds identically without sending anything for an unknown email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword('ghost@x.com');

      expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
      expect(result.message).toMatch(/reset code has been sent/);
    });

    it('still returns the generic success message when the mailer fails', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'ola@x.com', fullName: 'ola law' });
      prisma.passwordResetOtp.findFirst.mockResolvedValue(null);
      prisma.passwordResetOtp.create.mockResolvedValue({});
      mailer.send.mockRejectedValue(new Error('Resend 403'));

      await expect(service.forgotPassword('ola@x.com')).resolves.toEqual({
        message: 'If that email is registered, a reset code has been sent.',
      });
    });

    it('does not send a second code within the cooldown window', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'ola@x.com', fullName: 'ola law' });
      prisma.passwordResetOtp.findFirst.mockResolvedValue({ id: 'existing', createdAt: new Date() });

      await service.forgotPassword('ola@x.com');

      expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('issues a reset token for a correct, unexpired code', async () => {
      const codeHash = await argon2.hash('123456');
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'ola@x.com' });
      prisma.passwordResetOtp.findFirst.mockResolvedValue({
        id: 'otp1',
        codeHash,
        attempts: 0,
      });
      prisma.passwordResetOtp.update.mockResolvedValue({});
      jwt.signAsync.mockResolvedValue('reset-jwt');

      const result = await service.verifyOtp('ola@x.com', '123456');

      expect(result).toEqual({ resetToken: 'reset-jwt' });
      expect(prisma.passwordResetOtp.update).toHaveBeenCalledWith({
        where: { id: 'otp1' },
        data: { consumedAt: expect.any(Date) },
      });
      const signArgs = jwt.signAsync.mock.calls[0];
      expect(signArgs[0]).toEqual({ sub: 'u1', purpose: 'password_reset' });
    });

    it('rejects a wrong code and records the attempt', async () => {
      const codeHash = await argon2.hash('123456');
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'ola@x.com' });
      prisma.passwordResetOtp.findFirst.mockResolvedValue({
        id: 'otp1',
        codeHash,
        attempts: 0,
      });

      await expect(service.verifyOtp('ola@x.com', '000000')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.passwordResetOtp.update).toHaveBeenCalledWith({
        where: { id: 'otp1' },
        data: { attempts: { increment: 1 } },
      });
    });

    it('rejects once the attempt cap is hit, even with the right code', async () => {
      const codeHash = await argon2.hash('123456');
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'ola@x.com' });
      prisma.passwordResetOtp.findFirst.mockResolvedValue({
        id: 'otp1',
        codeHash,
        attempts: 5,
      });

      await expect(service.verifyOtp('ola@x.com', '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects for an unknown email without distinguishing the reason', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.verifyOtp('ghost@x.com', '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('resetPassword', () => {
    it('updates the password hash for a valid password_reset token', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 'u1', purpose: 'password_reset' });
      prisma.user.update.mockResolvedValue({});

      const result = await service.resetPassword('good-token', 'newpassword1');

      expect(result.message).toMatch(/reset successfully/);
      const arg = prisma.user.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'u1' });
      expect(typeof arg.data.passwordHash).toBe('string');
    });

    it('rejects a token with the wrong purpose', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 'u1', purpose: 'access' });
      await expect(service.resetPassword('bad-token', 'newpassword1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects an invalid/expired token', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('expired'));
      await expect(service.resetPassword('bad-token', 'newpassword1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
