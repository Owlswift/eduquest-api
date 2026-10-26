import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateNested, ArrayMaxSize } from 'class-validator';
import { ExamType } from '@prisma/client';

export class StartExamDto {
  @IsString()
  subjectId!: string;

  @IsEnum(ExamType)
  examType!: ExamType;

  /** Number of questions. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(60)
  count?: number;

  /** Time allowed; defaults to one minute per question. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(180)
  durationMinutes?: number;
}

export class ExamAnswerDto {
  @IsString()
  questionId!: string;

  @IsString()
  selectedOptionId!: string;
}

export class SaveExamAnswersDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ExamAnswerDto)
  answers!: ExamAnswerDto[];
}

export class SubmitExamDto {
  /** Optional final answers; merged over anything already autosaved. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ExamAnswerDto)
  answers?: ExamAnswerDto[];
}
