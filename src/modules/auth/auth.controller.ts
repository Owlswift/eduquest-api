import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('google')
  googleLogin(@Body() dto: GoogleAuthDto) {
    return this.auth.googleLogin(dto.idToken);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('logout')
  logout(@CurrentUser() user: any) {
    return this.auth.logout(user.id, user.tokenJti);
  }
}