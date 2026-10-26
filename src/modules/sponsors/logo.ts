/** Largest logo accepted. Logos are small; this also bounds what a request can make the database hold. */
export const MAX_LOGO_BYTES = 300 * 1024;

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * What the bytes really are, from their first bytes (never from the filename or
 * the browser's claim, which a person can set to anything). Only formats that
 * cannot carry script are allowed: an SVG could, so it is refused.
 */
export function sniffLogo(buf: Buffer): LogoType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Where a logo is served from. `PUBLIC_API_URL` is the API's public address including
 * its `/api` prefix (for example `https://api.example.com/api`); without it a path relative to the
 * server is returned. `v` changes when the logo does, so caches refresh.
 */
export function sponsorLogoUrl(sponsor: { id: string; logoUpdatedAt: Date }): string {
  const base = (process.env.PUBLIC_API_URL ?? '/api').replace(/\/+$/, '');
  return `${base}/sponsors/${sponsor.id}/logo?v=${sponsor.logoUpdatedAt.getTime()}`;
}

/** What students see of a sponsor: the logo and where it leads. Nothing about how they were contacted. */
export function publicSponsor(sponsor: { id: string; name: string; websiteUrl: string | null; logoUpdatedAt: Date } | null) {
  return sponsor ? { id: sponsor.id, name: sponsor.name, logoUrl: sponsorLogoUrl(sponsor), websiteUrl: sponsor.websiteUrl } : null;
}

/** The sponsor fields queries select (never the image bytes). */
export const SPONSOR_SELECT = { id: true, name: true, websiteUrl: true, logoUpdatedAt: true } as const;
