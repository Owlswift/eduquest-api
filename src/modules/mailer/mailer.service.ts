import { Injectable, Logger } from '@nestjs/common';

/**
 * Thin wrapper over the Resend REST API (no SDK dependency - it's a
 * single POST). If RESEND_API_KEY isn't set, emails are logged instead
 * of sent, so the rest of the app keeps working in an environment that
 * hasn't configured a provider yet.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  async send(to: string, subject: string, html: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM ?? 'EduQuest <onboarding@resend.dev>';

    if (!apiKey) {
      this.logger.warn(
        `RESEND_API_KEY not set - not sending email. Would have sent "${subject}" to ${to}:\n${html}`,
      );
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`Resend send failed (${response.status}): ${body}`);
      throw new Error('Failed to send email');
    }
  }
}
