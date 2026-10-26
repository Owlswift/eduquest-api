import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefreshDto {
  @IsString() @MaxLength(200) refreshToken!: string;
}

export class LogoutDto {
  /** This device's refresh token, so only its login ends. Older apps omit it and every login ends. */
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
}
