import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

// This is NOT a Passport strategy in the traditional sense.
// Instead we verify the Google ID token directly using google-auth-library.
// This is the correct approach for mobile apps (Flutter) where Google Sign-In
// returns an ID token directly — no redirect flow needed.

export interface GooglePayload {
  googleId: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
}

@Injectable()
export class GoogleTokenVerifier {
  private client: OAuth2Client;

  constructor() {
    this.client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }

  async verify(idToken: string): Promise<GooglePayload> {
    try {
      const ticket = await Promise.race([
        this.client.verifyIdToken({
          idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timed out contacting Google')),
            8000,
          ),
        ),
      ]);

      const payload = ticket.getPayload();

      if (!payload || !payload.email) {
        throw new UnauthorizedException('Invalid Google token');
      }

      return {
        googleId: payload.sub,
        email: payload.email,
        fullName: payload.name ?? payload.email.split('@')[0],
        avatarUrl: payload.picture ?? null,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Failed to verify Google token');
    }
  }
}