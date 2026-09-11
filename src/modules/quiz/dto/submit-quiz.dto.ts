import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';

export class QuizAnswerDto {
  @IsString()
  questionId!: string;

  /** The option id the student picked. Empty string if they left it blank
   *  (e.g. ran out of time) - it just won't match any correctAnswerId. */
  @IsString()
  selectedOptionId!: string;
}

export class SubmitQuizDto {
  @IsString()
  subjectId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  answers!: QuizAnswerDto[];

  @IsInt()
  @Min(0)
  timeTaken!: number; // seconds
}
