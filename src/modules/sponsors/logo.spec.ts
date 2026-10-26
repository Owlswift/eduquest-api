import { MAX_LOGO_BYTES, publicSponsor, sniffLogo, sponsorLogoUrl } from './logo';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

describe('sniffLogo', () => {
  it('recognises PNG, JPEG and WebP by their bytes', () => {
    expect(sniffLogo(png)).toBe('image/png');
    expect(sniffLogo(jpeg)).toBe('image/jpeg');
    expect(sniffLogo(webp)).toBe('image/webp');
  });
  it('refuses SVG, HTML, GIF, empty and truncated files, whatever they are called', () => {
    expect(sniffLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffLogo(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
    expect(sniffLogo(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffLogo(Buffer.alloc(0))).toBeNull();
    expect(sniffLogo(png.subarray(0, 4))).toBeNull();
    expect(sniffLogo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBeNull(); // RIFF, but audio
  });
  it('keeps the size limit modest', () => {
    expect(MAX_LOGO_BYTES).toBeLessThanOrEqual(512 * 1024);
  });
});

describe('logo urls', () => {
  const sponsor = { id: 's1', name: 'Acme Ltd', websiteUrl: 'https://acme.test', logoUpdatedAt: new Date(1_700_000_000_000) };
  afterEach(() => delete process.env.PUBLIC_API_URL);
  it('is relative by default and absolute when the API address is configured', () => {
    expect(sponsorLogoUrl(sponsor)).toBe('/api/sponsors/s1/logo?v=1700000000000');
    process.env.PUBLIC_API_URL = 'https://api.example.com/api/';
    expect(sponsorLogoUrl(sponsor)).toBe('https://api.example.com/api/sponsors/s1/logo?v=1700000000000');
  });
  it('shows students the logo, the name for its alt text and the link, and nothing else', () => {
    expect(Object.keys(publicSponsor(sponsor)!).sort()).toEqual(['id', 'logoUrl', 'name', 'websiteUrl']);
    expect(publicSponsor(null)).toBeNull();
  });
});
