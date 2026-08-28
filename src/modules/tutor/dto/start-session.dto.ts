import { ApiProperty } from '@nestjs/swagger';
import { ClassLevel } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

export class StartSessionDto {
  @ApiProperty({ example: 'biology' })
  @IsString()
  subjectId: string;

  @ApiProperty({ enum: ClassLevel, example: ClassLevel.SS1 })
  @IsEnum(ClassLevel)
  classLevel: ClassLevel;

  @ApiProperty({ description: 'CurriculumTopic.id to teach this session' })
  @IsString()
  topicId: string;
}
