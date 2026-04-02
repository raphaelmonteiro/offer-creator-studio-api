import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { UploadsModule } from '../uploads/uploads.module';
import { GalleryModule } from '../gallery/gallery.module';

@Module({
  imports: [UploadsModule, GalleryModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
