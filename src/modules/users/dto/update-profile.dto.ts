import { IsEnum, IsOptional, IsString, IsArray } from 'class-validator';
import { ClassLevel, ExamType } from '@prisma/client';

export class UpdateProfileDto {
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