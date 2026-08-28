import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Text-to-speech via local piper-tts. Runs entirely offline: no API key,
 * no per-request cost. Returns a WAV buffer the client can play directly.
 */
@Injectable()
export class VoiceTtsService {
  private readonly logger = new Logger(VoiceTtsService.name);
  private readonly piperBinPath: string;
  private readonly piperModelPath: string;

  constructor(private config: ConfigService) {
    this.piperBinPath = this.config.get<string>('PIPER_BIN_PATH') ?? 'piper';
    this.piperModelPath =
      this.config.get<string>('PIPER_MODEL_PATH') ??
      './models/piper/en_US-lessac-medium.onnx';
  }

  async synthesize(text: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'eduquest-tts-'));
    const outputPath = join(dir, 'output.wav');

    try {
      await this._run(
        this.piperBinPath,
        ['--model', this.piperModelPath, '--output_file', outputPath],
        text,
      );
      return await readFile(outputPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private _run(command: string, args: string[], stdin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.stdin.write(stdin);
      child.stdin.end();
      child.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`${command} exited with code ${code}: ${stderr}`);
          return reject(new InternalServerErrorException(`${command} failed`));
        }
        resolve();
      });
    });
  }
}
