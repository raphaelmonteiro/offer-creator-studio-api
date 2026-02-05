import { Client } from '../../clients/entities/client.entity';
export declare class Flyer {
    id: string;
    name: string;
    clientId: string | null;
    client: Client | null;
    thumbnailUrl: string | null;
    status: string;
    configuration: any;
    layout: string;
    customGridConfig: any | null;
    createdAt: Date;
    updatedAt: Date;
}
