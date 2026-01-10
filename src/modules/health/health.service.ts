import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  async check() {
    const dbStatus = await this.checkDatabase();

    const status = {
      status: dbStatus ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbStatus ? 'connected' : 'disconnected',
      environment: process.env.NODE_ENV || 'development',
    };

    return {
      success: true,
      data: status,
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch (error) {
      return false;
    }
  }
}
