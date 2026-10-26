import { IsString, MaxLength, MinLength } from 'class-validator';

export class CloseCompetitionDto {
  /** Why it is being closed early. Recorded in the audit log. */
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
