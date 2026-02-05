import { ConfigService } from '@nestjs/config';
export declare class EmailService {
    private configService;
    private transporter;
    constructor(configService: ConfigService);
    sendEmailVerification(email: string, name: string, token: string): Promise<any>;
    sendPasswordReset(email: string, name: string, token: string): Promise<any>;
}
