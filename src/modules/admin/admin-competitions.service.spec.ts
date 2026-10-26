import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminCompetitionsService } from './admin-competitions.service';

describe('AdminCompetitionsService', () => {
  let prisma: any;
  let audit: { log: jest.Mock; history: jest.Mock };
  let service: AdminCompetitionsService;
  const day = 86_400_000;
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
  const row = (startOffset: number, endOffset: number, over: Record<string, unknown> = {}) => ({
    id: 'c1', title: 'June Challenge', subtitle: 's', prizes: ['1GB data'], createdAt: new Date(),
    startsAt: new Date(Date.now() + startOffset * day), endsAt: new Date(Date.now() + endOffset * day),
    _count: { participants: 0 }, ...over,
  });

  beforeEach(() => {
    prisma = { competition: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() } };
    audit = { log: jest.fn().mockResolvedValue(undefined), history: jest.fn().mockResolvedValue([]) };
    service = new AdminCompetitionsService(prisma, audit as any);
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.competition.create.mockResolvedValue(row(1, 8));
      prisma.competition.findUnique.mockResolvedValue(row(1, 8));
    });

    it('creates and audits a valid competition', async () => {
      await service.create('admin1', { title: ' June Challenge ', subtitle: 's', prizes: [' 1GB data '], startsAt: iso(1), endsAt: iso(8) });
      const data = prisma.competition.create.mock.calls[0][0].data;
      expect(data.title).toBe('June Challenge');
      expect(data.prizes).toEqual(['1GB data']);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'competition.create', adminId: 'admin1' }));
    });

    it('rejects an end before the start, and an end already in the past', async () => {
      await expect(service.create('a', { title: 'xxx', subtitle: '', prizes: ['p'], startsAt: iso(5), endsAt: iso(2) })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create('a', { title: 'xxx', subtitle: '', prizes: ['p'], startsAt: iso(-9), endsAt: iso(-2) })).rejects.toThrow(/future/);
      await expect(service.create('a', { title: 'xxx', subtitle: '', prizes: ['p'], startsAt: 'nope', endsAt: iso(2) })).rejects.toThrow(/Invalid date/);
      expect(prisma.competition.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('allows date changes before it starts', async () => {
      prisma.competition.findUnique.mockResolvedValue(row(3, 10));
      prisma.competition.update.mockResolvedValue(row(4, 11));
      await service.update('a', 'c1', { startsAt: iso(4), endsAt: iso(11) });
      expect(prisma.competition.update).toHaveBeenCalled();
    });

    it('locks the dates once it has started, but lets copy and prizes change', async () => {
      prisma.competition.findUnique.mockResolvedValue(row(-1, 5));
      prisma.competition.update.mockResolvedValue(row(-1, 5, { title: 'New name' }));
      await expect(service.update('a', 'c1', { endsAt: iso(20) })).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.competition.update).not.toHaveBeenCalled();

      await service.update('a', 'c1', { title: 'New name', prizes: ['Tablet'] });
      expect(prisma.competition.update.mock.calls[0][0].data).toEqual({ title: 'New name', prizes: ['Tablet'] });
    });

    it('404s for an unknown competition', async () => {
      prisma.competition.findUnique.mockResolvedValue(null);
      await expect(service.update('a', 'ghost', { title: 'abc' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('refuses once students have joined', async () => {
      prisma.competition.findUnique.mockResolvedValue(row(-1, 5, { _count: { participants: 12 } }));
      await expect(service.remove('a', 'c1')).rejects.toThrow(/12 students/);
      expect(prisma.competition.delete).not.toHaveBeenCalled();
    });

    it('deletes an empty one and audits it', async () => {
      prisma.competition.findUnique.mockResolvedValue(row(2, 9));
      await service.remove('a', 'c1');
      expect(prisma.competition.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'competition.delete' }));
    });
  });

  it('reports status and whether dates are locked', async () => {
    prisma.competition.findMany.mockResolvedValue([row(2, 9, { id: 'up' }), row(-2, 3, { id: 'on' }), row(-9, -2, { id: 'end' })]);
    const rows = await service.list();
    expect(rows.map((r) => [r.id, r.status, r.datesLocked])).toEqual([['up', 'upcoming', false], ['on', 'ongoing', true], ['end', 'ended', true]]);
  });
});
