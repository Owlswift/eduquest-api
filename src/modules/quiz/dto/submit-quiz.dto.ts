import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class QuizAnswerDto {
  @IsString()
  questionId!: string;

  /** The option id the student picked. Empty string if they left it blank
   *  (e.g. ran out of time) - it just won't match any correctAnswerId. */
  @IsString()
  selectedOptionId!: string;
}

export class SubmitQuizDto {
  /** The session issued by GET /quiz/questions. The questions graded and
   *  rewarded are the ones the server issued for it, not anything the
   *  client sends. */
  @IsString()
  sessionId!: string;

  /** Ignored - the subject comes from the session. Still accepted so
   *  older clients that send it don't fail validation. */
  @IsOptional()
  @IsString()
  subjectId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  answers!: QuizAnswerDto[];

  @IsInt()
  @Min(0)
  timeTaken!: number; // seconds
}
