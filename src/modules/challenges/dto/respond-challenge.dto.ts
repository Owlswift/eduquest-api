import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class RespondChallengeDto {
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  topics!: string[];
}
