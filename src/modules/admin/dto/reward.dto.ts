import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PrizeKind } from '@prisma/client';

export class CreateRewardDto {
  /** Stable lowercase slug, e.g. `data_2gb`. Generated from the title when omitted. */
  @IsOptional() @IsString() @Matches(/^[a-z0-9_]{3,40}$/, { message: 'id must be 3 to 40 lowercase letters, digits or underscores' }) id?: string;
  @IsString() @MinLength(2) @MaxLength(60) title!: string;
  @IsString() @MinLength(1) @MaxLength(40) subtitle!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsInt() @Min(1) @Max(1_000_000) coinCost!: number;
  /** Units available; leave out for unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stock?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsEnum(PrizeKind) kind!: PrizeKind;
  @IsOptional() @IsString() @MaxLength(60) imageKey?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateRewardDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) title?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) coinCost?: number;
  /** A number sets the stock; `null` makes it unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stock?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsEnum(PrizeKind) kind?: PrizeKind;
  @IsOptional() @IsString() @MaxLength(60) imageKey?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}
