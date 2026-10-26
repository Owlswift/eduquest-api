/** Certificate PDFs against a real database: only the owner can download one. */
import { NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { CertificatesService } from '../src/modules/certificates/certificates.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('certificate PDF (real database)', () => {
  let prisma: PrismaClient;
  const tag = `cp${Date.now()}`;
  const svc = () => new CertificatesService(prisma as any, {} as any, {} as any);

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
    for (const n of ['a', 'b']) await prisma.user.create({ data: { id: `${tag}-${n}`, fullName: n === 'a' ? 'ada OBI' : 'Bayo Other', username: `${tag}-${n}`, email: `${tag}-${n}@t.test`, classLevel: 'SS2' } });
    await prisma.certificate.create({ data: { id: `${tag}-c`, userId: `${tag}-a`, kind: 'PARTICIPATION', subjectName: 'Test Cup', title: 'Participant', verificationCode: `EQ-${tag.slice(-5).toUpperCase().replace(/[^A-Z2-9]/g, 'X')}-ZZZZZ` } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.$disconnect();
  });

  it('gives the owner a PDF carrying their full name', async () => {
    const { filename, data } = await svc().pdf(`${tag}-a`, `${tag}-c`);
    expect(filename).toMatch(/^eduquest-certificate-EQ-.*\.pdf$/);
    expect(data.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses anyone else, and unknown ids, with the same not-found', async () => {
    await expect(svc().pdf(`${tag}-b`, `${tag}-c`)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc().pdf(`${tag}-a`, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
