import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectRedemptionDto {
  /** Why it could not be delivered. Shown to the student. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class FulfilRedemptionDto {
  /** What was sent, e.g. "1GB MTN, ref 12345". Shown to the student. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
