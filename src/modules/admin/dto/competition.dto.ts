import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCompetitionDto {
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsString() @MaxLength(240) subtitle!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  prizes!: string[];

  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}

export class UpdateCompetitionDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(240) subtitle?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  prizes?: string[];

  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
}
