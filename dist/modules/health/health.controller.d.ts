import { HealthService } from './health.service';
export declare class HealthController {
    private readonly healthService;
    constructor(healthService: HealthService);
    check(): Promise<{
        success: boolean;
        data: {
            status: string;
            timestamp: string;
            uptime: number;
            database: string;
            environment: string;
        };
    }>;
}
