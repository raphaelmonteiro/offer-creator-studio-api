import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollaboratorsController } from './collaborators.controller';
import { CollaboratorsService } from './collaborators.service';
import { User } from '../auth/entities/user.entity';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [TypeOrmModule.forFeature([User]), UploadsModule],
  controllers: [CollaboratorsController],
  providers: [CollaboratorsService],
  exports: [CollaboratorsService],
})
export class CollaboratorsModule {}
