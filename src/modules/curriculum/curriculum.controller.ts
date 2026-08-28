import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ClassLevel, CurriculumImportStatus } from '@prisma/client';
import { CurriculumService } from './curriculum.service';
import { CreateImportDto } from './dto/create-import.dto';
// Auth intentionally disabled on this controller - re-enable by restoring:
//   import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
//   import { RolesGuard } from '../../common/guards/roles.guard';
//   import { Roles } from '../../common/decorators/roles.decorator';
//   @ApiBearerAuth('access-token')
//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Roles(UserRole.ADMIN)
// on the class below.

@ApiTags('curriculum')
@Controller('curriculum')
export class CurriculumController {
  constructor(private curriculum: CurriculumService) {}

  // POST /curriculum/imports (multipart: file + subjectId + classLevel)
  @Post('imports')
  @ApiOperation({
    summary: 'Upload a curriculum PDF and extract its text, page by page',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'subjectId', 'classLevel'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'The curriculum PDF',
        },
        subjectId: {
          type: 'string',
          example: 'agric_science',
          description: 'Must match an existing Subject.id',
        },
        classLevel: { type: 'string', enum: Object.values(ClassLevel) },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        if (file.mimetype !== 'application/pdf') {
          return callback(
            new BadRequestException('Only PDF files are accepted'),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  async createImport(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CreateImportDto,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded (expected multipart field "file")',
      );
    }

    return this.curriculum.createImport({
      subjectId: body.subjectId,
      classLevel: body.classLevel,
      fileName: file.originalname,
      buffer: file.buffer,
    });
  }

  // GET /curriculum/imports?subjectId=&status=
  @Get('imports')
  @ApiOperation({ summary: 'List curriculum imports' })
  @ApiQuery({ name: 'subjectId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: CurriculumImportStatus })
  async listImports(
    @Query('subjectId') subjectId?: string,
    @Query('status') status?: CurriculumImportStatus,
  ) {
    return this.curriculum.listImports({ subjectId, status });
  }

  // GET /curriculum/imports/:id
  @Get('imports/:id')
  @ApiOperation({
    summary:
      'Get one curriculum import, including its raw pages and extracted JSON',
  })
  async getImport(@Param('id') id: string) {
    return this.curriculum.getImport(id);
  }

  // POST /curriculum/imports/:id/extract - runs the LLM extraction pass
  @Post('imports/:id/extract')
  @ApiOperation({
    summary:
      'Run the LLM extraction pass over every page of the import (can take minutes)',
  })
  async extract(@Param('id') id: string) {
    return this.curriculum.runExtraction(id);
  }

  // PATCH /curriculum/imports/:id - admin overwrites the extracted JSON after review
  @Patch('imports/:id')
  @ApiOperation({ summary: 'Overwrite the extracted JSON after manual review' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['topics'],
      properties: { topics: { type: 'array', items: { type: 'object' } } },
    },
  })
  async updateExtracted(
    @Param('id') id: string,
    @Body() body: { topics: unknown[] },
  ) {
    return this.curriculum.updateExtractedJson(id, body?.topics);
  }

  // POST /curriculum/imports/:id/approve - persists reviewed topics into CurriculumTopic
  @Post('imports/:id/approve')
  @ApiOperation({
    summary:
      'Approve the reviewed extraction, persisting it into CurriculumTopic',
  })
  async approve(@Param('id') id: string) {
    return this.curriculum.approveImport(id);
  }

  // GET /curriculum/topics?subjectId=&classLevel=
  @Get('topics')
  @ApiOperation({ summary: 'List saved curriculum topics' })
  @ApiQuery({ name: 'subjectId', required: false })
  @ApiQuery({ name: 'classLevel', required: false, enum: ClassLevel })
  async listTopics(
    @Query('subjectId') subjectId?: string,
    @Query('classLevel', new ParseEnumPipe(ClassLevel, { optional: true }))
    classLevel?: ClassLevel,
  ) {
    return this.curriculum.listTopics({ subjectId, classLevel });
  }
}
