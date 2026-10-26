import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ClassLevel, ExamType } from '@prisma/client';
import { NIGERIAN_STATES } from '../../common/geo/nigerian-states';
import { REGION_LABEL, REGION_STATES } from '../../common/geo/regions';

/** Fixed lists the apps need before anyone signs in (registration pickers). */
@ApiTags('meta')
@Controller('meta')
export class MetaController {
  // GET /meta
  @Get()
  get() {
    return {
      states: NIGERIAN_STATES,
      regions: Object.entries(REGION_STATES).map(([id, states]) => ({ id, name: REGION_LABEL[id as keyof typeof REGION_LABEL], states })),
      classLevels: Object.values(ClassLevel),
      examTypes: Object.values(ExamType),
    };
  }
}
