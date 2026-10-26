import { existsSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

const BLUE = '#1557E8';
const GOLD = '#FFB900';
const INK = '#1B2433';
const MUTED = '#5B6577';

export interface CertificateArt {
  kind: 'SUBJECT' | 'PARTICIPATION' | 'WINNER';
  /** The headline, e.g. "Lagos State Champion". */
  title: string;
  /** Subject name or competition title: what it is for. */
  subjectName: string;
  rank: number | null;
  holderName: string;
  issuedAt: Date;
  verificationCode: string;
}

/** "ola LAW" -> "Ola Law"; "ADE-BAYO o'neil" -> "Ade-Bayo O'Neil". */
export function titleCaseName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** The built-in PDF fonts cover Latin-1 only, so a name such as "Ọlá" would print
 *  with broken glyphs; fold dotted and accented letters to their base letter. */
export function printable(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7E\u00A0-\u00FF]/gu, '?');
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** The sentence between the holder's name and what they earned it for. */
export function citation(c: Pick<CertificateArt, 'kind' | 'rank'>): { heading: string; lead: string } {
  switch (c.kind) {
    case 'WINNER':
      return { heading: 'CERTIFICATE OF ACHIEVEMENT', lead: c.rank ? `secured ${ordinal(c.rank)} place in` : 'was a prize winner in' };
    case 'PARTICIPATION':
      return { heading: 'CERTIFICATE OF PARTICIPATION', lead: 'took part in' };
    default:
      return { heading: 'CERTIFICATE OF MASTERY', lead: 'demonstrated mastery of' };
  }
}

function logoPath(): string | null {
  const candidates = [process.env.CERTIFICATE_LOGO_PATH, join(process.cwd(), 'assets', 'eduquest_logo.png'), join(__dirname, '..', '..', '..', 'assets', 'eduquest_logo.png')];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/** Where the QR code sends a scanner: a page that calls GET /certificates/verify/:code. */
export function verifyUrl(code: string): string {
  const base = (process.env.CERTIFICATE_VERIFY_URL ?? 'https://eduquest.ng/verify').replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(code)}`;
}

/** Renders one certificate as an A4 landscape PDF. `compress: false` lets tests read the text. */
export async function renderCertificatePdf(c: CertificateArt, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const qr = await QRCode.toBuffer(verifyUrl(c.verificationCode), { margin: 1, width: 240, color: { dark: INK, light: '#FFFFFF' } });
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 0,
    compress: opts.compress ?? true,
    info: { Title: `${c.title} - ${c.verificationCode}`, Author: 'EduQuest', Subject: 'EduQuest certificate' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width;
  const H = doc.page.height;
  const { heading, lead } = citation(c);

  // Frame: a blue band, a white mat, and a thin gold rule inside it.
  doc.rect(0, 0, W, H).fill(BLUE);
  doc.rect(14, 14, W - 28, H - 28).fill('#FFFFFF');
  doc.rect(26, 26, W - 52, H - 52).lineWidth(1.5).stroke(GOLD);

  const logo = logoPath();
  if (logo) doc.image(logo, W / 2 - 28, 44, { fit: [56, 50], align: 'center' });
  doc.font('Helvetica-Bold').fontSize(14).fillColor(BLUE).text('EduQuest', 0, 100, { width: W, align: 'center', characterSpacing: 2 });

  doc.font('Helvetica-Bold').fontSize(26).fillColor(INK).text(heading, 0, 134, { width: W, align: 'center', characterSpacing: 1.5 });
  doc.rect(W / 2 - 40, 172, 80, 3).fill(GOLD);

  doc.font('Helvetica').fontSize(13).fillColor(MUTED).text('This is to certify that', 0, 192, { width: W, align: 'center' });

  // Shrink a very long name to fit on one line.
  const name = printable(titleCaseName(c.holderName));
  let size = 38;
  doc.font('Times-BoldItalic');
  while (size > 20 && doc.fontSize(size).widthOfString(name) > W - 160) size -= 2;
  doc.fillColor(BLUE).text(name, 60, 218, { width: W - 120, align: 'center', lineBreak: false });

  doc.font('Helvetica').fontSize(13).fillColor(MUTED).text(lead, 0, 280, { width: W, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(printable(c.subjectName), 80, 304, { width: W - 160, align: 'center' });
  if (c.kind !== 'SUBJECT' && c.title && c.title !== c.subjectName) {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#B07A00').text(printable(c.title), 80, doc.y + 6, { width: W - 160, align: 'center' });
  }

  // Footer: issue date, verification code, QR.
  const footY = H - 130;
  const date = c.issuedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('Date issued', 70, footY + 28, { width: 220 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(date, 70, footY + 44, { width: 220 });

  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('Verification code', W / 2 - 130, footY + 28, { width: 260, align: 'center' });
  doc.font('Courier-Bold').fontSize(16).fillColor(INK).text(c.verificationCode, W / 2 - 130, footY + 44, { width: 260, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(verifyUrl(c.verificationCode).replace(/^https?:\/\//, ''), W / 2 - 150, footY + 68, { width: 300, align: 'center' });

  doc.image(qr, W - 70 - 80, footY, { width: 80 });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Scan to verify', W - 70 - 80, footY + 82, { width: 80, align: 'center' });

  doc.end();
  return done;
}
