import { IsBoolean, IsOptional } from 'class-validator';

export class UpdatePreferencesDto {
  /** Streak reminders and "today's challenge is ready". */
  @IsOptional() @IsBoolean() studyReminders?: boolean;
  /** Competition opening, closing soon and results. */
  @IsOptional() @IsBoolean() competitions?: boolean;
  /** Badges, levels and certificates. */
  @IsOptional() @IsBoolean() achievements?: boolean;
  /** Push notifications at all. The in-app feed always works. */
  @IsOptional() @IsBoolean() push?: boolean;
}
