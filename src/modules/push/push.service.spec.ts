import { PushService } from './push.service';

describe('PushService', () => {
  let prisma: {
    deviceToken: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let service: PushService;

  beforeEach(() => {
    prisma = {
      deviceToken: { upsert: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
    };
    service = new PushService(prisma as any);
    // Deliberately not calling onModuleInit() - these tests exercise the
    // "no Firebase project configured" path, which is the default/only
    // reachable state in this environment (no FIREBASE_SERVICE_ACCOUNT_JSON).
  });

  describe('registerToken', () => {
    it('upserts by token so re-registering repoints it at the new user', async () => {
      await service.registerToken('u1', 'tok-abc', 'ios');
      expect(prisma.deviceToken.upsert).toHaveBeenCalledWith({
        where: { token: 'tok-abc' },
        create: { userId: 'u1', token: 'tok-abc', platform: 'ios' },
        update: { userId: 'u1', platform: 'ios' },
      });
    });
  });

  describe('unregisterToken', () => {
    it('deletes by token', async () => {
      await service.unregisterToken('tok-abc');
      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({ where: { token: 'tok-abc' } });
    });
  });

  describe('sendToUser', () => {
    it('is a no-op when the user has no registered devices', async () => {
      prisma.deviceToken.findMany.mockResolvedValue([]);
      await expect(service.sendToUser('u1', 'T', 'B')).resolves.toBeUndefined();
    });

    it('does not throw without a configured Firebase project - just logs', async () => {
      prisma.deviceToken.findMany.mockResolvedValue([{ id: 'd1', token: 'tok-abc' }]);
      await expect(service.sendToUser('u1', 'T', 'B')).resolves.toBeUndefined();
      // No messaging client configured -> nothing should be deleted either.
      expect(prisma.deviceToken.deleteMany).not.toHaveBeenCalled();
    });
  });
});
