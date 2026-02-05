import { Repository } from 'typeorm';
import { Flyer } from '../flyers/entities/flyer.entity';
import { Client } from '../clients/entities/client.entity';
import { Product } from '../products/entities/product.entity';
import { Template } from '../templates/entities/template.entity';
export declare class DashboardService {
    private flyerRepository;
    private clientRepository;
    private productRepository;
    private templateRepository;
    constructor(flyerRepository: Repository<Flyer>, clientRepository: Repository<Client>, productRepository: Repository<Product>, templateRepository: Repository<Template>);
    getStats(): Promise<{
        totalFlyers: number;
        totalClients: number;
        totalProducts: number;
        totalTemplates: number;
        recentFlyers: number;
        flyersThisMonth: number;
    }>;
    getRecent(limit?: number): Promise<{
        recentFlyers: {
            id: string;
            name: string;
            clientName: string;
            thumbnailUrl: string;
            updatedAt: Date;
        }[];
        recentTemplates: {
            id: string;
            name: string;
            type: string;
            thumbnailUrl: string;
            updatedAt: Date;
        }[];
    }>;
}
