import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let prisma: {
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let push: { sendToUser: jest.Mock };
  let service: NotificationsService;

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    service = new NotificationsService(prisma as any, push as any);
  });

  describe('notify', () => {
    it('creates the row and best-effort pushes it', async () => {
      prisma.notification.create.mockResolvedValue({ id: 'n1' });

      await service.notify('u1', 'badge_earned', 'Title', 'Body', { a: 'b' });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: { userId: 'u1', type: 'badge_earned', title: 'Title', body: 'Body', data: { a: 'b' } },
      });
      expect(push.sendToUser).toHaveBeenCalledWith('u1', 'Title', 'Body', { a: 'b' });
    });

    it('does not throw when the push send fails', async () => {
      prisma.notification.create.mockResolvedValue({ id: 'n1' });
      push.sendToUser.mockRejectedValue(new Error('fcm down'));

      await expect(service.notify('u1', 'x', 'T', 'B')).resolves.toEqual({ id: 'n1' });
    });
  });

  describe('list', () => {
    it('returns notifications newest first', async () => {
      prisma.notification.findMany.mockResolvedValue([
        { id: 'n1', type: 't', title: 'T', body: 'B', data: null, read: false, createdAt: new Date() },
      ]);
      const result = await service.list('u1');
      expect(result).toHaveLength(1);
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1' }, orderBy: { createdAt: 'desc' } }),
      );
    });
  });

  describe('unreadCount', () => {
    it('counts only unread notifications for that user', async () => {
      prisma.notification.count.mockResolvedValue(3);
      const result = await service.unreadCount('u1');
      expect(result).toEqual({ count: 3 });
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'u1', read: false },
      });
    });
  });

  describe('markRead / markAllRead', () => {
    it('scopes markRead to the owning user (via the where clause)', async () => {
      await service.markRead('u1', 'n1');
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'u1' },
        data: { read: true },
      });
    });

    it('marks every unread notification read for that user', async () => {
      await service.markAllRead('u1');
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', read: false },
        data: { read: true },
      });
    });
  });
});
