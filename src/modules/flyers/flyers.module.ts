import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlyersController } from './flyers.controller';
import { FlyersService } from './flyers.service';
import { Flyer } from './entities/flyer.entity';
import { UploadsModule } from '../uploads/uploads.module';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Flyer]),
    UploadsModule,
    ClientsModule,
  ],
  controllers: [FlyersController],
  providers: [FlyersService],
  exports: [FlyersService],
})
export class FlyersModule {}
