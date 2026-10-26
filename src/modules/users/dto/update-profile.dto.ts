import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsEnum, IsIn, IsOptional, IsString, IsArray, MinLength } from 'class-validator';
import { canonicalState, NIGERIAN_STATES } from '../../../common/geo/nigerian-states';
import { ClassLevel, ExamType } from '@prisma/client';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(ClassLevel)
  classLevel?: ClassLevel;

  @IsOptional()
  @Transform(({ value }) => canonicalState(value) ?? value)
  @IsIn(NIGERIAN_STATES as readonly string[], { message: 'state must be a Nigerian state, e.g. Lagos or FCT' })
  state?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  subjects?: string[];
}