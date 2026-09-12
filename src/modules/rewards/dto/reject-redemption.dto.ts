import { IsOptional, IsString } from 'class-validator';

export class RejectRedemptionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
