import { Module } from '@nestjs/common';
import { VoiceSttService } from './voice-stt.service';
import { VoiceTtsService } from './voice-tts.service';

@Module({
  providers: [VoiceSttService, VoiceTtsService],
  exports: [VoiceSttService, VoiceTtsService],
})
export class VoiceModule {}
