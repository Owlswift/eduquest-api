import { IsEnum, IsOptional, IsString, IsArray, MinLength } from 'class-validator';
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
  @IsString()
  state?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subjects?: string[];
}