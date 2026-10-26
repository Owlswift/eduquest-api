import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUrl, MaxLength, MinLength, ValidateIf } from 'class-validator';

/** Multipart form fields arrive as strings; an empty website means "none". */
export class SponsorDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'The website must be a full web address starting with http:// or https://' })
  @MaxLength(300)
  websiteUrl?: string | null;
}
