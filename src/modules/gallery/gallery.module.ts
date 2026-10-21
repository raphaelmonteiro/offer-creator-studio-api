import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GalleryImage } from './entities/gallery-image.entity';
import { GalleryFolder } from './entities/gallery-folder.entity';
import { GalleryService } from './gallery.service';
import { GalleryController } from './gallery.controller';
import { ClientPreferredImagesService } from './client-preferred-images.service';
import { GalleryImageEanService } from './gallery-image-ean.service';
import { GalleryProductLinkService } from './gallery-product-link.service';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [TypeOrmModule.forFeature([GalleryImage, GalleryFolder]), UploadsModule],
  controllers: [GalleryController],
  providers: [
    GalleryService,
    ClientPreferredImagesService,
    GalleryImageEanService,
    GalleryProductLinkService,
  ],
  exports: [GalleryService],
})
export class GalleryModule {}
