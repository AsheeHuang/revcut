import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const app = buildApp({ logger: true });
await app.listen({ host: '127.0.0.1', port: config.port });
