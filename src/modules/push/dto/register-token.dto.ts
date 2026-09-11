import { IsIn, IsString } from 'class-validator';

export class RegisterTokenDto {
  @IsString()
  token!: string;

  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';
}
