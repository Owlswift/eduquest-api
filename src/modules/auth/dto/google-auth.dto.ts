import { IsNotEmpty, IsString } from 'class-validator';

export class GoogleAuthDto {
  @IsString()
  @IsNotEmpty()
  idToken: string; // The Google ID token sent from Flutter
}