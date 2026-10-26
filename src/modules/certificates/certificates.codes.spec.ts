import { CertificatesService } from './certificates.service';

describe('certificate verification codes', () => {
  it('look like EQ-XXXXX-XXXXX and avoid ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = CertificatesService.newCode();
      expect(code).toMatch(/^EQ-[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
      expect(code).not.toMatch(/[ILO01]/);
    }
  });

  it('do not repeat in a large sample', () => {
    const codes = new Set(Array.from({ length: 5000 }, () => CertificatesService.newCode()));
    expect(codes.size).toBe(5000);
  });
});

describe('CertificatesService.verify', () => {
  const prisma: any = { certificate: { findUnique: jest.fn() }, competition: { findUnique: jest.fn() } };
  const service = new CertificatesService(prisma, {} as any, {} as any);

  it('treats an unknown code as invalid', async () => {
    prisma.certificate.findUnique.mockResolvedValue(null);
    expect(await service.verify('EQ-NOPE0-NOPE0')).toEqual({ valid: false });
  });

  it('is case and whitespace tolerant and shows only a first name and initial', async () => {
    prisma.certificate.findUnique.mockResolvedValue({
      verificationCode: 'EQ-ABCDE-FGHJK', kind: 'WINNER', title: 'Lagos State Champion', subjectName: 'June', rank: 1,
      competitionId: 'c1', createdAt: new Date('2026-07-01'), user: { fullName: 'ada nwosu' },
    });
    prisma.competition.findUnique.mockResolvedValue({ title: 'June Challenge', type: 'STATE', endsAt: new Date('2026-06-30') });
    const out: any = await service.verify('  eq-abcde-fghjk ');
    expect(prisma.certificate.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { verificationCode: 'EQ-ABCDE-FGHJK' } }));
    expect(out).toMatchObject({ valid: true, holder: 'Ada N.', title: 'Lagos State Champion', rank: 1, competition: { title: 'June Challenge', type: 'STATE' } });
    expect(JSON.stringify(out)).not.toMatch(/nwosu|email|phone/i);
  });
});
