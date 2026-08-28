import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Speech-to-text via local whisper.cpp. Runs entirely offline: no API key,
 * no per-request cost. Incoming audio (whatever format the client recorded
 * in) is normalised to 16kHz mono WAV with ffmpeg first, since whisper.cpp
 * expects that format.
 */
@Injectable()
export class VoiceSttService {
  private readonly logger = new Logger(VoiceSttService.name);
  private readonly whisperCliPath: string;
  private readonly whisperModelPath: string;

  constructor(private config: ConfigService) {
    this.whisperCliPath =
      this.config.get<string>('WHISPER_CLI_PATH') ?? 'whisper-cli';
    this.whisperModelPath =
      this.config.get<string>('WHISPER_MODEL_PATH') ??
      './models/whisper/ggml-base.en.bin';
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'eduquest-voice-'));
    const inputPath = join(dir, `input.${this._extensionFor(mimeType)}`);
    const wavPath = join(dir, 'input-16k.wav');

    try {
      await writeFile(inputPath, audioBuffer);
      await this._run('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        wavPath,
      ]);
      const text = await this._run(this.whisperCliPath, [
        '-m',
        this.whisperModelPath,
        '-f',
        wavPath,
        '-np',
        '-nt',
      ]);
      return text.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private _extensionFor(mimeType: string): string {
    if (mimeType.includes('webm')) return 'webm';
    if (
      mimeType.includes('mp4') ||
      mimeType.includes('m4a') ||
      mimeType.includes('aac')
    )
      return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('wav')) return 'wav';
    return 'bin';
  }

  private _run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`${command} exited with code ${code}: ${stderr}`);
          return reject(new InternalServerErrorException(`${command} failed`));
        }
        resolve(stdout);
      });
    });
  }
}
