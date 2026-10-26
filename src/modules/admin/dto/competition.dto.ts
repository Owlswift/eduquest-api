import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ClassLevel, CompetitionType, PrizeKind, Region } from '@prisma/client';

/** What a competition is scored by: one fixed set of questions, or a league of points earned from practice quizzes. */
export const CREATABLE_FORMATS = ['FIXED_SET', 'POINTS_LEAGUE'] as const;
import { canonicalState, NIGERIAN_STATES } from '../../../common/geo/nigerian-states';

export class PrizeInputDto {
  /** First finishing position this prize covers (1 = winner). */
  @IsInt() @Min(1) positionFrom!: number;
  /** Last position it covers; equal to positionFrom for a single place. */
  @IsInt() @Min(1) positionTo!: number;
  @IsString() @MinLength(2) @MaxLength(120) title!: string;
  @IsEnum(PrizeKind) kind!: PrizeKind;
  /** Required for COINS prizes: paid automatically when the award is fulfilled. */
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) coinAmount?: number;
}

export class CreateCompetitionDto {
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsString() @MaxLength(240) subtitle!: string;
  /** Full rules and terms, shown to students before they enter. */
  @IsOptional() @IsString() @MaxLength(8000) description?: string;

  @IsEnum(CompetitionType) type!: CompetitionType;

  // Who can enter.
  @IsOptional() @IsArray() @IsEnum(ClassLevel, { each: true }) classLevels?: ClassLevel[];
  /** Subjects the questions come from; leave empty for every subject of the class levels. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) subjectIds?: string[];
  /** Required for STATE competitions. */
  @IsOptional()
  @Transform(({ value }) => canonicalState(value) ?? value)
  @IsIn(NIGERIAN_STATES as readonly string[], { message: 'state must be a Nigerian state' })
  state?: string;
  /** Required for REGIONAL competitions. */
  @IsOptional() @IsEnum(Region) region?: Region;

  /** Defaults to FIXED_SET. */
  @IsOptional() @IsIn(CREATABLE_FORMATS as unknown as string[]) format?: (typeof CREATABLE_FORMATS)[number];

  // How it is scored.
  /** Required for FIXED_SET. */
  @IsOptional() @IsInt() @Min(5) @Max(100) questionCount?: number;
  // POINTS_LEAGUE: a fixed number of points per qualifying quiz, up to a daily maximum.
  @IsOptional() @IsInt() @Min(1) @Max(1000) pointsPerQuiz?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) dailyPointsCap?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) minQuestionsPerQuiz?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) pointsPerCorrect?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) penaltyPerWrong?: number;
  /** Minutes a student has once they start; leave empty for "until it closes". */
  @IsOptional() @IsInt() @Min(1) @Max(240) timeLimitMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) participationXp?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) participationCoins?: number;
  @IsOptional() @IsInt() @Min(1) @Max(90) claimDeadlineDays?: number;

  /** Shown as "Sponsored by" with the sponsor's logo. */
  @IsOptional() @IsString() sponsorId?: string;

  // Stages. Leave out for an ordinary standalone competition.
  /** Entry only for students an earlier stage qualified (e.g. a national final). */
  @IsOptional() @IsBoolean() requiresQualification?: boolean;
  /** The later competition this one's top finishers advance to. */
  @IsOptional() @IsString() nextStageId?: string;
  /** How many top finishers advance (required with nextStageId). */
  @IsOptional() @IsInt() @Min(1) @Max(10_000) advanceCount?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PrizeInputDto) prizes?: PrizeInputDto[];

  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}

/** What may change depends on the stage: everything in a draft, copy / dates /
 *  prizes once published but not started, and only the wording once it runs. */
export class UpdateCompetitionDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(240) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;

  @IsOptional() @IsEnum(CompetitionType) type?: CompetitionType;
  @IsOptional() @IsArray() @IsEnum(ClassLevel, { each: true }) classLevels?: ClassLevel[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) subjectIds?: string[];
  @IsOptional()
  @Transform(({ value }) => canonicalState(value) ?? value)
  @IsIn(NIGERIAN_STATES as readonly string[], { message: 'state must be a Nigerian state' })
  state?: string;
  @IsOptional() @IsEnum(Region) region?: Region;

  @IsOptional() @IsInt() @Min(5) @Max(100) questionCount?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) pointsPerCorrect?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) penaltyPerWrong?: number;
  @IsOptional() @IsInt() @Min(1) @Max(240) timeLimitMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) participationXp?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) participationCoins?: number;
  @IsOptional() @IsInt() @Min(1) @Max(90) claimDeadlineDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) pointsPerQuiz?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) dailyPointsCap?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) minQuestionsPerQuiz?: number;

  /** Send null to remove the sponsor. */
  @IsOptional() @IsString() sponsorId?: string | null;

  // Stages. Leave out for an ordinary standalone competition.
  /** Entry only for students an earlier stage qualified (e.g. a national final). */
  @IsOptional() @IsBoolean() requiresQualification?: boolean;
  /** The later competition this one's top finishers advance to. */
  /** Send null to unlink. */
  @IsOptional() @IsString() nextStageId?: string | null;
  /** How many top finishers advance (required with nextStageId). */
  @IsOptional() @IsInt() @Min(1) @Max(10_000) advanceCount?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PrizeInputDto) prizes?: PrizeInputDto[];

  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
}
