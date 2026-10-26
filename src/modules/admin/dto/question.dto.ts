import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { ClassLevel, ExamType, QuestionStatus } from '@prisma/client';

export class OptionInputDto {
  /** Keep the id of an existing option when editing so past attempts still point at it. */
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text!: string;
}

export class CreateQuestionDto {
  @IsString()
  subjectId!: string;

  @IsEnum(ClassLevel)
  classLevel!: ClassLevel;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  topic?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  questionText!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  explanation?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  difficulty?: number;

  @IsOptional()
  @IsEnum(ExamType)
  examType?: ExamType;

  @IsOptional()
  @IsInt()
  @Min(1990)
  @Max(2100)
  examYear?: number;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => OptionInputDto)
  options!: OptionInputDto[];

  /** Position of the right answer in `options`. */
  @IsInt()
  @Min(0)
  correctIndex!: number;

  /** Defaults to DRAFT: a new question is reviewed before students see it. */
  @IsOptional()
  @IsEnum(QuestionStatus)
  status?: QuestionStatus;
}

export class UpdateQuestionDto {
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsEnum(ClassLevel) classLevel?: ClassLevel;
  @IsOptional() @IsString() @MaxLength(120) topic?: string | null;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(4000) questionText?: string;
  @IsOptional() @IsString() @MaxLength(4000) explanation?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(5) difficulty?: number;
  @IsOptional() @IsEnum(ExamType) examType?: ExamType | null;
  @IsOptional() @IsInt() @Min(1990) @Max(2100) examYear?: number | null;

  /** Replaces the whole option set. Required together with `correctIndex`. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => OptionInputDto)
  options?: OptionInputDto[];

  @IsOptional() @IsInt() @Min(0) correctIndex?: number;
}

export class SetStatusDto {
  @IsEnum(QuestionStatus)
  status!: QuestionStatus;
}
