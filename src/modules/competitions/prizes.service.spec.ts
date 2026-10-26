import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CLAIM_REQUIREMENTS, normalisePhone, PrizesService } from './prizes.service';

describe('normalisePhone', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['0803 123 4567', '+2348031234567'],
    ['+234 803-123-4567', '+2348031234567'],
    ['2347012345678', '+2347012345678'],
    ['09012345678', '+2349012345678'],
  ])('accepts %s', (input, expected) => expect(normalisePhone(input)).toBe(expected));

  it.each([['0803123456'], ['12345'], ['0603123456789'], ['abc'], [''], ['+4478123456789']])('rejects %s', (input) =>
    expect(normalisePhone(input)).toBeNull(),
  );
});

describe('PrizesService', () => {
  let prisma: any;
  let ledger: { grant: jest.Mock };
  let notifications: { notify: jest.Mock };
  let service: PrizesService;
  const soon = () => new Date(Date.now() + 5 * 86_400_000);
  const award = (kind: string, over: Record<string, unknown> = {}) => ({
    id: 'a1', userId: 'u1', competitionId: 'c1', prizeId: 'p1', rank: 1, status: 'AWAITING_CLAIM', claimDeadline: soon(),
    prize: { title: 'Prize', kind, coinAmount: kind === 'COINS' ? 500 : null }, ...over,
  });

  beforeEach(() => {
    prisma = {
      prizeAward: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn(), aggregate: jest.fn(), create: jest.fn() },
      competition: { findUniqueOrThrow: jest.fn().mockResolvedValue({ claimDeadlineDays: 14, title: 'June' }) },
      competitionParticipant: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    ledger = { grant: jest.fn().mockResolvedValue({ applied: true, coins: 500, xp: 0 }) };
    notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    service = new PrizesService(prisma, ledger as any, notifications as any);
  });

  describe('claim', () => {
    it('asks for more from the high-value prizes, because students are minors', () => {
      expect(CLAIM_REQUIREMENTS.DEVICE).toEqual({ contactPhone: true, guardianPhone: true, note: true });
      expect(CLAIM_REQUIREMENTS.SCHOLARSHIP.guardianPhone).toBe(true);
      expect(CLAIM_REQUIREMENTS.AIRTIME.guardianPhone).toBe(false);
      expect(CLAIM_REQUIREMENTS.COINS.contactPhone).toBe(false);
    });

    it('lets a coin prize be claimed with nothing', async () => {
      prisma.prizeAward.findFirst.mockResolvedValue(award('COINS'));
      await expect(service.claim('u1', 'a1', {})).resolves.toEqual({ claimed: true, status: 'CLAIMED' });
    });

    it('stores a normalised phone for airtime and refuses a bad one', async () => {
      prisma.prizeAward.findFirst.mockResolvedValue(award('AIRTIME'));
      await expect(service.claim('u1', 'a1', { contactPhone: '123' })).rejects.toBeInstanceOf(BadRequestException);
      await service.claim('u1', 'a1', { contactPhone: '0803 123 4567' });
      expect(prisma.prizeAward.updateMany.mock.calls[0][0].data.claimDetails).toEqual({ contactPhone: '+2348031234567' });
    });

    it('needs a guardian number and a delivery note for a device', async () => {
      prisma.prizeAward.findFirst.mockResolvedValue(award('DEVICE'));
      await expect(service.claim('u1', 'a1', { contactPhone: '08031234567', note: 'Lagos' })).rejects.toThrow(/parent or guardian/);
      await expect(service.claim('u1', 'a1', { contactPhone: '08031234567', guardianPhone: '08051234567' })).rejects.toThrow(/deliver/);
      await service.claim('u1', 'a1', { contactPhone: '08031234567', guardianPhone: '08051234567', guardianName: ' Mrs Bello ', note: ' 12 Ikoyi Rd ' });
      expect(prisma.prizeAward.updateMany.mock.calls[0][0].data.claimDetails).toEqual({
        contactPhone: '+2348031234567', guardianPhone: '+2348051234567', guardianName: 'Mrs Bello', note: '12 Ikoyi Rd',
      });
    });

    it('refuses someone else\'s prize, a claimed one, an expired one, and a lost race', async () => {
      prisma.prizeAward.findFirst.mockResolvedValue(null);
      await expect(service.claim('intruder', 'a1', {})).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.prizeAward.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a1', userId: 'intruder' } }));

      prisma.prizeAward.findFirst.mockResolvedValue(award('COINS', { status: 'CLAIMED' }));
      await expect(service.claim('u1', 'a1', {})).rejects.toThrow(/already claimed/);
      prisma.prizeAward.findFirst.mockResolvedValue(award('COINS', { claimDeadline: new Date(Date.now() - 1000) }));
      await expect(service.claim('u1', 'a1', {})).rejects.toThrow(/claim period/);
      prisma.prizeAward.findFirst.mockResolvedValue(award('COINS'));
      prisma.prizeAward.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.claim('u1', 'a1', {})).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verify', () => {
    it('needs a claim first for a physical prize, but not for coins or a certificate', async () => {
      prisma.prizeAward.findUnique.mockResolvedValue(award('DEVICE'));
      await service.verify('admin1', 'a1');
      expect(prisma.prizeAward.updateMany.mock.calls[0][0].where).toEqual({ id: 'a1', status: { in: ['CLAIMED'] } });

      prisma.prizeAward.findUnique.mockResolvedValue(award('COINS'));
      await service.verify('admin1', 'a1');
      expect(prisma.prizeAward.updateMany.mock.calls[1][0].where.status.in).toEqual(['AWAITING_CLAIM', 'CLAIMED']);
    });

    it('explains why a physical prize cannot be verified yet', async () => {
      prisma.prizeAward.findUnique.mockResolvedValue(award('AIRTIME'));
      prisma.prizeAward.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.verify('admin1', 'a1')).rejects.toThrow(/has to claim/);
    });
  });

  describe('fulfil', () => {
    it('pays a coin prize through the ledger exactly in the same transaction as the status change', async () => {
      prisma.prizeAward.findUnique.mockResolvedValue(award('COINS', { status: 'VERIFIED' }));
      const res = await service.fulfil('admin1', 'a1', 'ok');
      expect(ledger.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', coins: 500, key: 'prize:a1', reason: 'competition_prize' }), prisma);
      expect(res).toEqual({ status: 'FULFILLED', coinsPaid: 500 });
      expect(notifications.notify).toHaveBeenCalledWith('u1', 'prize_fulfilled', expect.any(String), expect.stringContaining('500 coins'), { awardId: 'a1' });
    });

    it('pays nothing for a physical prize, and refuses an unverified one without paying', async () => {
      prisma.prizeAward.findUnique.mockResolvedValue(award('DATA', { status: 'VERIFIED' }));
      expect((await service.fulfil('admin1', 'a1')).coinsPaid).toBe(0);
      expect(ledger.grant).not.toHaveBeenCalled();

      prisma.prizeAward.findUnique.mockResolvedValue(award('COINS'));
      prisma.prizeAward.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.fulfil('admin1', 'a1')).rejects.toThrow(/Only a verified prize/);
      expect(ledger.grant).not.toHaveBeenCalled();
    });
  });

  describe('forfeit and reject', () => {
    beforeEach(() => {
      prisma.prizeAward.findUnique.mockResolvedValue(award('DEVICE', { status: 'CLAIMED', rank: 1 }));
      prisma.prizeAward.aggregate.mockResolvedValue({ _max: { rank: 3 } });
    });

    it('passes the prize to the next finisher after the deepest awarded place', async () => {
      prisma.competitionParticipant.findFirst.mockResolvedValue({ userId: 'u9', rank: 4 });
      prisma.prizeAward.create.mockResolvedValue({ id: 'a2', userId: 'u9', rank: 4, claimDeadline: soon(), prize: { title: 'Tablet' } });

      const res = await service.forfeit('admin1', 'a1', 'Could not be reached');

      expect(prisma.competitionParticipant.findFirst.mock.calls[0][0].where).toMatchObject({ status: 'COMPLETED', rank: { gt: 3 }, user: { prizeAwards: { none: { competitionId: 'c1' } } } });
      expect(prisma.prizeAward.create.mock.calls[0][0].data).toMatchObject({ userId: 'u9', rank: 4, prizeId: 'p1', promotedFromId: 'a1' });
      expect(res).toEqual({ status: 'FORFEITED', promotedTo: { awardId: 'a2', rank: 4, userId: 'u9' } });
      expect(notifications.notify).toHaveBeenCalledWith('u1', 'prize_forfeited', expect.any(String), 'Could not be reached', expect.anything());
      expect(notifications.notify).toHaveBeenCalledWith('u9', 'prize_won', expect.stringContaining('Tablet'), expect.any(String), expect.anything());
    });

    it('can close without passing on, and copes with nobody left', async () => {
      const noPromo = await service.reject('admin1', 'a1', 'Identical answer sheet', false);
      expect(noPromo).toEqual({ status: 'REJECTED', promotedTo: null });
      expect(prisma.competitionParticipant.findFirst).not.toHaveBeenCalled();

      prisma.competitionParticipant.findFirst.mockResolvedValue(null);
      expect((await service.forfeit('admin1', 'a1', 'Never claimed')).promotedTo).toBeNull();
    });

    it('refuses to close a prize that is already closed or delivered', async () => {
      prisma.prizeAward.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.forfeit('admin1', 'a1', 'too late')).rejects.toThrow(/already closed/);
      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });
});
