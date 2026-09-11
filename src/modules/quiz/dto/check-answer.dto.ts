import { IsString } from 'class-validator';

export class CheckAnswerDto {
  @IsString()
  selectedOptionId!: string;
}
