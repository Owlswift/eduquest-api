import { IsEnum, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ClassLevel } from '@prisma/client';

export class CreateImportDto {
  @ApiProperty({
    example: 'agric_science',
    description: 'Must match an existing Subject.id',
  })
  @IsString()
  subjectId: string;

  @ApiProperty({ enum: ClassLevel })
  @IsEnum(ClassLevel)
  classLevel: ClassLevel;
}
