import {
  BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SponsorDto } from './dto/sponsor.dto';
import { MAX_LOGO_BYTES } from './logo';
import { SponsorsService } from './sponsors.service';

const upload = FileInterceptor('logo', { limits: { fileSize: MAX_LOGO_BYTES + 1, files: 1 } });

/** Public: a logo is shown to every student, so it needs no login. */
@ApiTags('sponsors')
@Controller('sponsors')
export class SponsorsPublicController {
  constructor(private sponsors: SponsorsService) {}

  @Get(':id/logo')
  @ApiOperation({ summary: "A sponsor's logo image (no login)" })
  async logo(@Param('id') id: string, @Headers('if-none-match') ifNoneMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { data, type, updatedAt } = await this.sponsors.logo(id);
    const etag = `"${updatedAt.getTime()}"`;
    // The `?v=` in the url changes with the logo, so it can be cached for a long time.
    res.set({ ETag: etag, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
      // Helmet's default would stop the admin site (another origin) from showing the image; logos are public by design.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (ifNoneMatch === etag) {
      res.status(304);
      return;
    }
    return new StreamableFile(data, { type, disposition: 'inline' });
  }
}

@ApiTags('admin')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/sponsors')
export class AdminSponsorsController {
  constructor(private sponsors: SponsorsService) {}

  @Get()
  @ApiOperation({ summary: 'Sponsors, with how many competitions show each' })
  list() {
    return this.sponsors.list();
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Add a sponsor: name, optional website, and the logo file (PNG, JPEG or WebP, up to 300 KB)' })
  @UseInterceptors(upload)
  create(@CurrentUser() admin: any, @Body() dto: SponsorDto, @UploadedFile() logo?: Express.Multer.File) {
    return this.sponsors.create(admin.sub, dto, logo?.buffer);
  }

  @Patch(':id')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Change a sponsor. Send the logo file only to replace it' })
  @UseInterceptors(upload)
  update(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: SponsorDto, @UploadedFile() logo?: Express.Multer.File) {
    if (dto.name === undefined && dto.websiteUrl === undefined && !logo) throw new BadRequestException('Nothing to change');
    return this.sponsors.update(admin.sub, id, dto, logo?.buffer);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a sponsor that no open competition shows' })
  remove(@CurrentUser() admin: any, @Param('id') id: string) {
    return this.sponsors.remove(admin.sub, id);
  }
}
