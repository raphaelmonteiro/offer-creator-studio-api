import { DashboardService } from './dashboard.service';
import { QueryDashboardDto } from './dto/query-dashboard.dto';
export declare class DashboardController {
    private readonly dashboardService;
    constructor(dashboardService: DashboardService);
    getStats(): Promise<{
        totalFlyers: number;
        totalClients: number;
        totalProducts: number;
        totalTemplates: number;
        recentFlyers: number;
        flyersThisMonth: number;
    }>;
    getRecent(query: QueryDashboardDto): Promise<{
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
