import { DataSource } from 'typeorm';
export declare class HealthService {
    private dataSource;
    constructor(dataSource: DataSource);
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
    private checkDatabase;
}
