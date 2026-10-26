import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ClaimPrizeDto {
  /** A phone number we can reach the winner on. */
  @IsOptional() @IsString() @MaxLength(20) contactPhone?: string;
  /** A parent or guardian's number: required for the high-value prizes (students are minors). */
  @IsOptional() @IsString() @MaxLength(20) guardianPhone?: string;
  @IsOptional() @IsString() @MaxLength(100) guardianName?: string;
  /** Where and how to deliver it. */
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
