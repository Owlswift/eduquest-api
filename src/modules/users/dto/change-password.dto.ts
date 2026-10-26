import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;

  /** This device's refresh token, so changing the password does not sign this device out. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}
