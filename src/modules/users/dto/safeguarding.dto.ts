import { Equals, IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

export class GuardianConsentDto {
  @IsString() @MinLength(2) @MaxLength(100) guardianName!: string;
  /** A Nigerian mobile number we can reach the parent or guardian on. */
  @IsString() @MaxLength(20) guardianPhone!: string;
  /** Must be true: the parent or guardian agrees to the privacy and safeguarding policy. */
  @IsBoolean() @Equals(true, { message: 'A parent or guardian must agree to the policy' }) consent!: boolean;
}

export class AcceptPolicyDto {
  /** The version being accepted: must be the current one from GET /legal/policy. */
  @IsString() @MaxLength(60) version!: string;
}
