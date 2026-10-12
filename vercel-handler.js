import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { handleRequest } from './render/proxy.js';

export default async function handler(req, res) {
    try {
        const forwardedHost = req.headers['x-forwarded-host'];
        const host = (Array.isArray(forwardedHost)
            ? forwardedHost[0]
            : forwardedHost) || req.headers.host;
        if (!host) {
            res.statusCode = 400;
            res.end('Bad Request');
            return;
        }

        const forwardedProto = req.headers['x-forwarded-proto'];
        const protocol = ((Array.isArray(forwardedProto)
            ? forwardedProto[0]
            : forwardedProto) || 'https').split(',')[0].trim();
        const functionUrl = new URL(req.url || '/', `${protocol}://${host}`);
        const originalPath = functionUrl.searchParams.get('__proxy_path') || '/';
        functionUrl.searchParams.delete('__proxy_path');
        const proxyPath = originalPath.startsWith('/')
            ? originalPath
            : `/${originalPath}`;
        const url = new URL(
            `${proxyPath}${functionUrl.search}`,
            `${protocol}://${host}`
        );
        const headers = new Headers();

        for (const [name, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) {
                headers.set(name, name.toLowerCase() === 'cookie'
                    ? value.join('; ')
                    : value.join(', '));
            } else if (value !== undefined) {
                headers.set(name, value);
            }
        }

        const method = req.method || 'GET';
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const request = new Request(url, {
            method,
            headers,
            body: hasBody ? Readable.toWeb(req) : undefined,
            ...(hasBody ? { duplex: 'half' } : {})
        });
        const response = await handleRequest(request);

        res.statusCode = response.status;
        for (const [name, value] of response.headers) {
            if (name.toLowerCase() !== 'set-cookie') {
                res.setHeader(name, value);
            }
        }

        const setCookies = response.headers.getSetCookie();
        if (setCookies.length > 0) {
            res.setHeader('set-cookie', setCookies);
        }

        if (!response.body) {
            res.end();
            return;
        }

        await pipeline(Readable.fromWeb(response.body), res);
    } catch (error) {
        if (res.headersSent) {
            res.destroy(error);
            return;
        }

        console.error('[VERCEL HANDLER ERROR]', error);
        res.statusCode = 502;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end('Bad Gateway');
    }
}
