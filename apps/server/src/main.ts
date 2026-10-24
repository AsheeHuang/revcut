import postgres from 'postgres';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createHealthChecks } from './health';

const config = loadConfig();
const sql = postgres(config.databaseUrl);
const app = buildApp({ checks: createHealthChecks(config, sql), logger: true });
app.addHook('onClose', () => sql.end());
await app.listen({ host: '127.0.0.1', port: config.port });
