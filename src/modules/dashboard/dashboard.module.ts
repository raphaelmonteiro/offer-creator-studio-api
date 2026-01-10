import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Flyer } from '../flyers/entities/flyer.entity';
import { Client } from '../clients/entities/client.entity';
import { Product } from '../products/entities/product.entity';
import { Template } from '../templates/entities/template.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Flyer, Client, Product, Template]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
