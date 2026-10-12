import { handleRequest, cleanupCache } from './proxy.js';

const PORT = Number(process.env.PORT || 3000);

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    reusePort: true,
    idleTimeout: 120,
    fetch: handleRequest
});

setInterval(cleanupCache, 30 * 1000);

console.log(`Reverse proxy listening on port ${PORT}`);
