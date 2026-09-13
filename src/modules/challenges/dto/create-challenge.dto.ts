import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class CreateChallengeDto {
  @IsString()
  opponentId!: string;

  @IsString()
  subjectId!: string;

  /** Topics the challenger cares about within the subject - may be empty
   *  if the subject has no tagged topics yet (or the player has no
   *  preference), in which case the question pool is just randomised
   *  across the whole subject. */
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  topics!: string[];
}
