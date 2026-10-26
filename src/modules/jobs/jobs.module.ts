import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { ScheduledTasksService } from './scheduled-tasks.service';

@Module({
  providers: [ScheduledTasksService, JobsService],
  exports: [ScheduledTasksService, JobsService],
})
export class JobsModule {}
