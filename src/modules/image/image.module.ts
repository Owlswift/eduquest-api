import { Module } from '@nestjs/common';
import { ImageGenService } from './image-gen.service';

@Module({
  providers: [ImageGenService],
  exports: [ImageGenService],
})
export class ImageModule {}
