import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let prisma: {
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      createMany: jest.Mock;
      findUnique: jest.Mock;
    };
    notificationPreference: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock };
    $queryRaw: jest.Mock;
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
        createMany: jest.fn(),
        findUnique: jest.fn(),
      },
      notificationPreference: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
      $queryRaw: jest.fn(),
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

  describe('preferences', () => {
    const prefs = (over: Record<string, unknown>) => ({ userId: 'u1', studyReminders: true, competitions: true, achievements: true, push: true, ...over });

    it('sends nothing for a category the student switched off', async () => {
      prisma.notificationPreference.findUnique.mockResolvedValue(prefs({ studyReminders: false }));
      expect(await service.notify('u1', 'streak_reminder', 'T', 'B')).toBeNull();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(push.sendToUser).not.toHaveBeenCalled();
    });

    it('still delivers prize and reward messages when everything is off', async () => {
      prisma.notificationPreference.findUnique.mockResolvedValue(prefs({ studyReminders: false, competitions: false, achievements: false, push: false }));
      prisma.notification.create.mockResolvedValue({ id: 'n1' });
      await service.notify('u1', 'prize_won', 'T', 'B');
      expect(prisma.notification.create).toHaveBeenCalled();
    });

    it('keeps the in-app notification but skips the push when push is off', async () => {
      prisma.notificationPreference.findUnique.mockResolvedValue(prefs({ push: false }));
      prisma.notification.create.mockResolvedValue({ id: 'n1' });
      await service.notify('u1', 'level_up', 'T', 'B');
      expect(prisma.notification.create).toHaveBeenCalled();
      expect(push.sendToUser).not.toHaveBeenCalled();
    });

    it('stores only the changes the student sent', async () => {
      prisma.notificationPreference.upsert.mockResolvedValue(prefs({ competitions: false }));
      const out = await service.updatePreferences('u1', { competitions: false });
      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({ where: { userId: 'u1' }, create: { userId: 'u1', competitions: false }, update: { competitions: false } });
      expect(out).toEqual({ studyReminders: true, competitions: false, achievements: true, push: true });
    });

    it('defaults to everything on for a student who never opened settings', async () => {
      expect(await service.preferencesFor('u1')).toEqual({ studyReminders: true, competitions: true, achievements: true, push: true });
    });
  });

  describe('scheduled notifications', () => {
    it('drops a repeat of the same dedupe key without pushing', async () => {
      prisma.notification.createMany.mockResolvedValue({ count: 0 });
      expect(await service.notify('u1', 'streak_reminder', 'T', 'B', undefined, { dedupeKey: 'k1' })).toBeNull();
      expect(push.sendToUser).not.toHaveBeenCalled();
      prisma.notification.createMany.mockResolvedValue({ count: 1 });
      prisma.notification.findUnique.mockResolvedValue({ id: 'n9' });
      expect(await service.notify('u1', 'streak_reminder', 'T', 'B', undefined, { dedupeKey: 'k2' })).toEqual({ id: 'n9' });
      expect(prisma.notification.createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    });

    it('notifyMany inserts in chunks, skips opted-out students and pushes only to new rows with push on', async () => {
      prisma.notificationPreference.findMany.mockResolvedValue([
        { userId: 'off', studyReminders: false, competitions: true, achievements: true, push: true },
        { userId: 'nopush', studyReminders: true, competitions: true, achievements: true, push: false },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ dedupeKey: 'k:a' }, { dedupeKey: 'k:nopush' }]); // k:b was already sent
      const item = (userId: string, key: string) => ({ userId, type: 'streak_reminder', title: 'T', body: 'B', dedupeKey: key });

      const sent = await service.notifyMany([item('a', 'k:a'), item('b', 'k:b'), item('off', 'k:off'), item('nopush', 'k:nopush')]);

      expect(sent).toBe(2);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(push.sendToUser.mock.calls.map((c) => c[0])).toEqual(['a']); // not b (repeat), not off, not nopush
    });

    it('notifyMany does nothing when everyone opted out', async () => {
      prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'off', studyReminders: false, competitions: true, achievements: true, push: true }]);
      expect(await service.notifyMany([{ userId: 'off', type: 'streak_reminder', title: 'T', body: 'B', dedupeKey: 'k' }])).toBe(0);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('notifyMany splits large batches', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const items = Array.from({ length: 1200 }, (_, i) => ({ userId: `u${i}`, type: 'streak_reminder', title: 'T', body: 'B', dedupeKey: `k${i}` }));
      await service.notifyMany(items, 500);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
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
