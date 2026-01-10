import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Flyer } from '../flyers/entities/flyer.entity';
import { Client } from '../clients/entities/client.entity';
import { Product } from '../products/entities/product.entity';
import { Template } from '../templates/entities/template.entity';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Flyer)
    private flyerRepository: Repository<Flyer>,
    @InjectRepository(Client)
    private clientRepository: Repository<Client>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(Template)
    private templateRepository: Repository<Template>,
  ) {}

  async getStats() {
    const [
      totalFlyers,
      totalClients,
      totalProducts,
      totalTemplates,
    ] = await Promise.all([
      this.flyerRepository.count(),
      this.clientRepository.count(),
      this.productRepository.count(),
      this.templateRepository.count(),
    ]);

    // Count recent flyers (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentFlyers = await this.flyerRepository
      .createQueryBuilder('flyer')
      .where('flyer.createdAt >= :date', { date: sevenDaysAgo })
      .getCount();

    // Count flyers this month
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const flyersThisMonth = await this.flyerRepository
      .createQueryBuilder('flyer')
      .where('flyer.createdAt >= :date', { date: startOfMonth })
      .getCount();

    return {
      totalFlyers,
      totalClients,
      totalProducts,
      totalTemplates,
      recentFlyers,
      flyersThisMonth,
    };
  }

  async getRecent(limit: number = 5) {
    const [recentFlyers, recentTemplates] = await Promise.all([
      this.flyerRepository.find({
        take: limit,
        order: { updatedAt: 'DESC' },
        relations: ['client'],
      }),
      this.templateRepository.find({
        take: limit,
        order: { updatedAt: 'DESC' },
      }),
    ]);

    return {
      recentFlyers: recentFlyers.map((flyer) => ({
        id: flyer.id,
        name: flyer.name,
        clientName: flyer.client?.name || null,
        thumbnailUrl: flyer.thumbnailUrl,
        updatedAt: flyer.updatedAt,
      })),
      recentTemplates: recentTemplates.map((template) => ({
        id: template.id,
        name: template.name,
        type: template.type,
        thumbnailUrl: template.thumbnailUrl,
        updatedAt: template.updatedAt,
      })),
    };
  }
}
