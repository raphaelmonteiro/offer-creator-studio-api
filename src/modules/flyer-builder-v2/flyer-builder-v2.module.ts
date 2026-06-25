import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlyerBuilderV2Controller } from './flyer-builder-v2.controller';
import { FlyerBuilderV2Service } from './flyer-builder-v2.service';
import { FlyerBuilderV2Document } from './entities/flyer-builder-v2-document.entity';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [TypeOrmModule.forFeature([FlyerBuilderV2Document]), ClientsModule],
  controllers: [FlyerBuilderV2Controller],
  providers: [FlyerBuilderV2Service],
  exports: [FlyerBuilderV2Service],
})
export class FlyerBuilderV2Module {}
