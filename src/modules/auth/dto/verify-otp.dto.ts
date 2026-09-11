import { IsEmail, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @Length(6, 6)
  code!: string;
}
