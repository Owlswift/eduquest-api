import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CloseCompetitionDto {
  /** Why it is being closed early. Recorded in the audit log. */
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class ReasonDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

/** Closing a prize award (forfeit or reject), optionally passing it to the next place. */
export class CloseAwardDto extends ReasonDto {
  /** Default true: the next finisher without a prize inherits it. */
  @IsOptional()
  @IsBoolean()
  promote?: boolean;
}

export class FulfilAwardDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
