import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { Client } from './entities/client.entity';
import { ClientContact } from './entities/client-contact.entity';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Client, ClientContact]),
    UploadsModule,
  ],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService, TypeOrmModule],
})
export class ClientsModule {}
