import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ClassLevel, ExamType } from '@prisma/client';
import { NIGERIAN_STATES } from '../../common/geo/nigerian-states';

/** Fixed lists the apps need before anyone signs in (registration pickers). */
@ApiTags('meta')
@Controller('meta')
export class MetaController {
  // GET /meta
  @Get()
  get() {
    return {
      states: NIGERIAN_STATES,
      classLevels: Object.values(ClassLevel),
      examTypes: Object.values(ExamType),
    };
  }
}
