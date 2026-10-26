import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { loadPolicy } from '../../common/safeguarding';

/** Public: the policy has to be readable before anyone signs up. */
@ApiTags('legal')
@Controller('legal')
export class LegalController {
  @Get('policy')
  @ApiOperation({ summary: 'The current privacy and child safeguarding policy: its version and the text (Markdown)' })
  policy() {
    const { version, text } = loadPolicy();
    return { version, format: 'markdown', text };
  }
}
