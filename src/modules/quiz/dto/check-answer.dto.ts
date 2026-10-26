import { IsString } from 'class-validator';

export class CheckAnswerDto {
  /** The session issued by GET /quiz/questions that contains the question. */
  @IsString()
  sessionId!: string;

  @IsString()
  selectedOptionId!: string;
}
