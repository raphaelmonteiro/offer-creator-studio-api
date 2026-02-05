"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const flyer_entity_1 = require("../flyers/entities/flyer.entity");
const client_entity_1 = require("../clients/entities/client.entity");
const product_entity_1 = require("../products/entities/product.entity");
const template_entity_1 = require("../templates/entities/template.entity");
let DashboardService = class DashboardService {
    constructor(flyerRepository, clientRepository, productRepository, templateRepository) {
        this.flyerRepository = flyerRepository;
        this.clientRepository = clientRepository;
        this.productRepository = productRepository;
        this.templateRepository = templateRepository;
    }
    async getStats() {
        const [totalFlyers, totalClients, totalProducts, totalTemplates,] = await Promise.all([
            this.flyerRepository.count(),
            this.clientRepository.count(),
            this.productRepository.count(),
            this.templateRepository.count(),
        ]);
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentFlyers = await this.flyerRepository
            .createQueryBuilder('flyer')
            .where('flyer.createdAt >= :date', { date: sevenDaysAgo })
            .getCount();
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
    async getRecent(limit = 5) {
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
};
exports.DashboardService = DashboardService;
exports.DashboardService = DashboardService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(flyer_entity_1.Flyer)),
    __param(1, (0, typeorm_1.InjectRepository)(client_entity_1.Client)),
    __param(2, (0, typeorm_1.InjectRepository)(product_entity_1.Product)),
    __param(3, (0, typeorm_1.InjectRepository)(template_entity_1.Template)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
], DashboardService);
//# sourceMappingURL=dashboard.service.js.map