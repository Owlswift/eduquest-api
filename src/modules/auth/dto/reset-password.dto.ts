import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  resetToken!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}
