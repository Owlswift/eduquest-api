import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class PostMessageDto {
  @ApiProperty({ example: 'I think sunlight gives the plant energy?' })
  @IsString()
  @MinLength(1)
  content: string;
}
