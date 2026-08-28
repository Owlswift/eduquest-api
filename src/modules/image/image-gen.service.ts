import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

async function findFirstPng(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFirstPng(entryPath);
      if (found) return found;
    } else if (entry.name.endsWith('.png')) {
      return entryPath;
    }
  }
  return null;
}

/**
 * Illustrative text-to-image generation via Apple's Core ML port of Stable
 * Diffusion 1.5, run locally (no API key, no per-request cost). Reserved
 * for purely decorative visuals - anything label-critical goes through the
 * Mermaid "diagram" block instead, since diffusion models are unreliable at
 * rendering correct labels/anatomy and this is educational content.
 */
@Injectable()
export class ImageGenService {
  private readonly logger = new Logger(ImageGenService.name);
  private readonly pythonBinPath: string;
  private readonly resourcesDir: string;
  private readonly modelVersion: string;

  constructor(private config: ConfigService) {
    this.pythonBinPath =
      this.config.get<string>('SD_PYTHON_BIN_PATH') ?? 'python3';
    this.resourcesDir =
      this.config.get<string>('SD_RESOURCES_DIR') ??
      './models/sd/original/compiled';
    this.modelVersion =
      this.config.get<string>('SD_MODEL_VERSION') ??
      'runwayml/stable-diffusion-v1-5';
  }

  async generate(prompt: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'eduquest-image-'));

    try {
      await this._run(this.pythonBinPath, [
        '-m',
        'python_coreml_stable_diffusion.pipeline',
        '--prompt',
        prompt,
        '-i',
        this.resourcesDir,
        '-o',
        dir,
        '--compute-unit',
        'CPU_AND_GPU',
        '--model-version',
        this.modelVersion,
        '--model-sources',
        'compiled',
        '--seed',
        String(Math.floor(Math.random() * 1_000_000)),
      ]);

      // The pipeline saves the PNG nested under a prompt-slug subdirectory,
      // e.g. <dir>/<prompt_slug>/randomSeed_..._modelVersion_....png.
      const png = await findFirstPng(dir);
      if (!png) {
        throw new Error('No PNG produced in output dir');
      }
      return await readFile(png);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private _run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`${command} exited with code ${code}: ${stderr}`);
          return reject(
            new InternalServerErrorException('Image generation failed'),
          );
        }
        resolve();
      });
    });
  }
}
