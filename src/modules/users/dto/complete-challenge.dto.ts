import { Type } from 'class-transformer';
import { IsArray, IsString, ValidateNested } from 'class-validator';
import { QuizAnswerDto } from '../../quiz/dto/submit-quiz.dto';

export class CompleteChallengeDto {
  /** The session issued by GET /quiz/questions for the starter questions. */
  @IsString()
  sessionId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  answers!: QuizAnswerDto[];
}
