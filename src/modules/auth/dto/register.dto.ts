import { Transform } from 'class-transformer';
import { IsArray, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { canonicalState, NIGERIAN_STATES } from '../../../common/geo/nigerian-states';

export class RegisterDto {
  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  // A blank picker value means "not chosen"; anything else must be a real state.
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : (canonicalState(value) ?? value)))
  @IsIn(NIGERIAN_STATES as readonly string[], { message: 'state must be a Nigerian state, e.g. Lagos or FCT' })
  state?: string;

  @IsOptional()
  @IsString()
  institution?: string;

  @IsOptional()
  @IsString()
  age?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  interests?: string[];
}
