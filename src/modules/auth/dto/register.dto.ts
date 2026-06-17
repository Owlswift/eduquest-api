import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { ClassLevel, ExamType } from '@prisma/client';

export class RegisterDto {
  @IsString()
  fullName!: string;

  @IsString()
  username!: string;

  @IsEmail()
  email!: string;

  @MinLength(6)
  password!: string;

  @IsEnum(ClassLevel)
  classLevel!: ClassLevel;

  @IsEnum(ExamType)
  examTarget!: ExamType;
}