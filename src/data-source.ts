import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

/**
 * DataSource standalone para o CLI do TypeORM (migration:generate/run/revert).
 *
 * O `DatabaseConfig` (src/config/database.config.ts) é um provider do Nest e NÃO
 * serve para o CLI, que exige um export de `DataSource`. Os dois espelham a mesma
 * config; aqui `synchronize` é sempre false — migration é o único caminho de schema.
 *
 * Os globs usam `{.ts,.js}` para funcionar tanto via ts-node (rodando de src/)
 * quanto compilado (rodando de dist/). O `.env` é lido do diretório atual, então
 * rode sempre a partir da raiz do backend.
 */
dotenv.config();

// Um único export de DataSource: o CLI do TypeORM recusa o arquivo se houver mais de um.
const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'stepup_user',
  password: process.env.DB_PASSWORD ?? 'secret123',
  database: process.env.DB_DATABASE ?? 'flyer_db',
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: false,
});

export default AppDataSource;
