import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ClassLevel } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TutorService } from './tutor.service';
import { VoiceTtsService } from '../voice/voice-tts.service';
import { ImageGenService } from '../image/image-gen.service';
import { StartSessionDto } from './dto/start-session.dto';
import { PostMessageDto } from './dto/post-message.dto';

@ApiTags('tutor')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('tutor')
export class TutorController {
  constructor(
    private tutor: TutorService,
    private tts: VoiceTtsService,
    private imageGen: ImageGenService,
  ) {}

  // POST /tutor/sessions
  @Post('sessions')
  @ApiOperation({ summary: 'Start a new tutor session for a curriculum topic' })
  async startSession(@CurrentUser() user: any, @Body() dto: StartSessionDto) {
    return this.tutor.startSession(user.sub, dto);
  }

  // POST /tutor/sessions/:id/messages
  @Post('sessions/:id/messages')
  @ApiOperation({
    summary: 'Send a student message and get the next tutor turn',
  })
  async postMessage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: PostMessageDto,
  ) {
    return this.tutor.postMessage(user.sub, id, dto.content);
  }

  // POST /tutor/sessions/:id/skip-assessment
  @Post('sessions/:id/skip-assessment')
  @ApiOperation({
    summary:
      'Skip the remaining prior-knowledge questions and jump straight to teaching',
  })
  async skipAssessment(@CurrentUser() user: any, @Param('id') id: string) {
    return this.tutor.skipAssessment(user.sub, id);
  }

  // POST /tutor/sessions/:id/voice-messages (multipart: audio)
  @Post('sessions/:id/voice-messages')
  @ApiOperation({
    summary:
      'Speak a student message (audio file) and get the next tutor turn, transcribed locally via whisper.cpp',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: {
          type: 'string',
          format: 'binary',
          description: 'Recorded student speech (webm, m4a, ogg, or wav)',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('audio', { limits: { fileSize: 15 * 1024 * 1024 } }),
  )
  async postVoiceMessage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @UploadedFile() audio: Express.Multer.File,
  ) {
    if (!audio) {
      throw new BadRequestException(
        'No audio uploaded (expected multipart field "audio")',
      );
    }
    return this.tutor.postVoiceMessage(
      user.sub,
      id,
      audio.buffer,
      audio.mimetype,
    );
  }

  // GET /tutor/messages/:messageId/audio
  @Get('messages/:messageId/audio')
  @ApiOperation({
    summary:
      "Synthesize a tutor message's text into speech (WAV) locally via piper-tts",
  })
  async getMessageAudio(
    @CurrentUser() user: any,
    @Param('messageId') messageId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const text = await this.tutor.getMessageTextForAudio(user.sub, messageId);
    const audio = await this.tts.synthesize(text);
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': audio.length.toString(),
    });
    return new StreamableFile(audio);
  }

  // GET /tutor/messages/:messageId/diagram
  @Get('messages/:messageId/diagram')
  @ApiOperation({
    summary:
      "Get a tutor message's diagram as Mermaid syntax (client renders it - no invented visuals, exactly what the tutor taught)",
  })
  async getMessageDiagram(
    @CurrentUser() user: any,
    @Param('messageId') messageId: string,
  ) {
    return this.tutor.getMessageDiagram(user.sub, messageId);
  }

  // GET /tutor/messages/:messageId/illustration
  @Get('messages/:messageId/illustration')
  @ApiOperation({
    summary:
      "Generate a tutor message's illustration block into an image (PNG) locally via Core ML Stable Diffusion",
  })
  async getMessageIllustration(
    @CurrentUser() user: any,
    @Param('messageId') messageId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const prompt = await this.tutor.getMessageIllustrationPrompt(
      user.sub,
      messageId,
    );
    const image = await this.imageGen.generate(prompt);
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': image.length.toString(),
    });
    return new StreamableFile(image);
  }

  // GET /tutor/sessions/:id
  @Get('sessions/:id')
  @ApiOperation({
    summary: 'Get a tutor session with its full message history',
  })
  async getSession(@CurrentUser() user: any, @Param('id') id: string) {
    return this.tutor.getSession(user.sub, id);
  }

  // GET /tutor/sessions/:id/flashcards
  @Get('sessions/:id/flashcards')
  @ApiOperation({
    summary:
      'Collect every flashcard block generated in a session, for spaced review',
  })
  async getFlashcards(@CurrentUser() user: any, @Param('id') id: string) {
    return this.tutor.getFlashcards(user.sub, id);
  }

  // GET /tutor/mastery?subjectId=&classLevel=
  @Get('mastery')
  @ApiOperation({
    summary: "List the current student's mastery scores per topic",
  })
  @ApiQuery({ name: 'subjectId', required: false })
  @ApiQuery({ name: 'classLevel', required: false, enum: ClassLevel })
  async listMastery(
    @CurrentUser() user: any,
    @Query('subjectId') subjectId?: string,
    @Query('classLevel') classLevel?: ClassLevel,
  ) {
    return this.tutor.listMastery(user.sub, subjectId, classLevel);
  }
}
