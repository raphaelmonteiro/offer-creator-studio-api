import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FontsController } from './fonts.controller';
import { FontsService } from './fonts.service';
import { Font } from './entities/font.entity';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [TypeOrmModule.forFeature([Font]), UploadsModule],
  controllers: [FontsController],
  providers: [FontsService],
  exports: [FontsService],
})
export class FontsModule {}
