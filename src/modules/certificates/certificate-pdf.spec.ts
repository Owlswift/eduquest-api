import { citation, ordinal, printable, renderCertificatePdf, titleCaseName, verifyUrl } from './certificate-pdf';

/** The strings drawn on the page: pdfkit writes each as a kerned `[<hex> n <hex>] TJ` array. */
const drawn = (pdf: Buffer) =>
  [...pdf.toString('latin1').matchAll(/\[([^\]]*)\] TJ/g)].map((m) => [...m[1].matchAll(/<([0-9a-f]*)>/gi)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''));

const base = { kind: 'WINNER' as const, title: 'Lagos State Champion', subjectName: 'Lagos State Monthly Challenge', rank: 1, holderName: 'ada OBI', issuedAt: new Date('2026-10-26T10:00:00Z'), verificationCode: 'EQ-7KQ2M-9XDRT' };

describe('certificate helpers', () => {
  it('title-cases names, including hyphens and apostrophes', () => {
    expect(titleCaseName('  ada   OBI ')).toBe('Ada Obi');
    expect(titleCaseName("ADE-BAYO o'neil")).toBe("Ade-Bayo O'Neil");
  });
  it('folds dotted and accented letters so built-in fonts do not break', () => {
    expect(printable('Ọlá Adéwálé')).toBe('Ola Adewale');
    expect(printable('Chidi 😀')).toBe('Chidi ?');
  });
  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });
  it('words each kind differently', () => {
    expect(citation({ kind: 'WINNER', rank: 2 })).toEqual({ heading: 'CERTIFICATE OF ACHIEVEMENT', lead: 'secured 2nd place in' });
    expect(citation({ kind: 'WINNER', rank: null }).lead).toBe('was a prize winner in');
    expect(citation({ kind: 'PARTICIPATION', rank: null }).heading).toBe('CERTIFICATE OF PARTICIPATION');
    expect(citation({ kind: 'SUBJECT', rank: null }).lead).toBe('demonstrated mastery of');
  });
  it('builds the verify link from the configured base, trimming slashes', () => {
    process.env.CERTIFICATE_VERIFY_URL = 'https://example.org/check//';
    expect(verifyUrl('EQ-AAAAA-BBBBB')).toBe('https://example.org/check/EQ-AAAAA-BBBBB');
    delete process.env.CERTIFICATE_VERIFY_URL;
  });
});

describe('renderCertificatePdf', () => {
  it('produces a one-page A4 landscape PDF with the name, award, code and date', async () => {
    const pdf = await renderCertificatePdf(base, { compress: false });
    const text = pdf.toString('latin1');
    const shown = drawn(pdf);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
    expect(shown).toEqual(expect.arrayContaining(['CERTIFICATE OF ACHIEVEMENT', 'Ada Obi', 'secured 1st place in', 'Lagos State Monthly Challenge', 'Lagos State Champion', 'EQ-7KQ2M-9XDRT', '26 October 2026']));
  });
  it('prints participation and subject certificates with their own wording', async () => {
    const shown = async (c: object) => drawn(await renderCertificatePdf({ ...base, ...c }, { compress: false }));
    expect(await shown({ kind: 'PARTICIPATION', rank: null, title: 'Participant' })).toEqual(expect.arrayContaining(['CERTIFICATE OF PARTICIPATION', 'took part in']));
    const subject = await shown({ kind: 'SUBJECT', rank: null, subjectName: 'Physics', title: 'Physics mastery' });
    expect(subject).toEqual(expect.arrayContaining(['CERTIFICATE OF MASTERY', 'demonstrated mastery of', 'Physics']));
  });
  it('fits a very long name on the page without throwing', async () => {
    const pdf = await renderCertificatePdf({ ...base, holderName: 'Oluwadamilolatobiloba Chukwuemeka Abdulrahman-Ogunbanjo' });
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
