import { waitUntil } from '@vercel/functions';

/*
 * ============================================================
 * Bun High Performance Reverse Proxy
 * ============================================================
 *
 * Target:
 *   https://hx.rstp.jp
 *
 * Video behavior:
 *   1. Preserve the client's Range.
 *   2. Origin -> client is streamed immediately.
 *   3. 2 MiB is ONLY the internal cache chunk size.
 *   4. Cached ranges are served directly from memory.
 *   5. On a cache miss, one exact Origin Range request is made.
 *   6. The incoming Cookie / Authorization is forwarded to Origin.
 *   7. Video cache is shared between clients.
 *   8. If Origin ignores Range and returns 200, a streaming fallback
 *      slices the body without buffering the whole video.
 *
 * ============================================================
 */


/* ============================================================
 * Configuration
 * ============================================================ */

const TARGET_ORIGIN = process.env.TARGET_ORIGIN || 'https://hx.rstp.jp';


/* General cache */
const CACHE_TTL = 15 * 1000;
const CACHE_MAX_SIZE = 10 * 1024 * 1024;


/* Video cache */
const VIDEO_CHUNK_SIZE = 2 * 1024 * 1024;
const VIDEO_CACHE_TTL = 10 * 60 * 1000;


/* Shared cache memory */
const CACHE_MAX_TOTAL_SIZE = 80 * 1024 * 1024;


/* Prefetch the next internal chunk after a streamed miss. */
const VIDEO_READ_AHEAD = 1;


/* When serving cached data, don't enqueue a whole 2 MiB chunk at once. */
const CACHE_STREAM_PIECE_SIZE = 128 * 1024;


/* Cache cleanup */
const CACHE_CLEANUP_INTERVAL = 30 * 1000;


/* ============================================================
 * Headers
 * ============================================================ */

const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);


/* ============================================================
 * Cache state
 * ============================================================ */

/*
 * General cache:
 * key -> {
 *   status,
 *   headers,
 *   body: ArrayBuffer,
 *   size,
 *   expiresAt,
 *   lastAccess
 * }
 */
const generalCache = new Map();


/*
 * Video metadata:
 * url -> {
 *   totalLength,
 *   contentType,
 *   expiresAt,
 *   lastAccess
 * }
 */
const videoMetaCache = new Map();


/*
 * Video chunks:
 * url|chunk=N -> {
 *   body: Uint8Array,
 *   size,
 *   start,
 *   end,
 *   totalLength,
 *   contentType,
 *   chunkIndex,
 *   expiresAt,
 *   lastAccess
 * }
 */
const videoChunkCache = new Map();


/* General request coalescing */
const inflight = new Map();


/* Read-ahead coalescing */
const videoPrefetchInflight = new Map();


/* Total bytes held by general + video chunk caches. */
let cacheTotalSize = 0;


/* ============================================================
 * Utility
 * ============================================================
 */

function now() {
    return Date.now();
}


function isSafePositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}


function debugVideo(...args) {
    if (process.env.DEBUG_VIDEO === '1') {
        console.log('[VIDEO]', ...args);
    }
}


/* ============================================================
 * LRU
 * ============================================================
 */

function touchCache(cache, key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    entry.lastAccess = now();
    return entry;
}


function removeGeneralCache(key) {
    const entry = generalCache.get(key);

    if (!entry) {
        return;
    }

    cacheTotalSize -= entry.size || 0;
    generalCache.delete(key);

    if (cacheTotalSize < 0) {
        cacheTotalSize = 0;
    }
}


function removeVideoChunk(key) {
    const entry = videoChunkCache.get(key);

    if (!entry) {
        return;
    }

    cacheTotalSize -= entry.size || 0;
    videoChunkCache.delete(key);

    if (cacheTotalSize < 0) {
        cacheTotalSize = 0;
    }
}


function enforceGlobalMemoryLimit() {
    while (cacheTotalSize > CACHE_MAX_TOTAL_SIZE) {
        const generalFirst = generalCache.keys().next();
        const videoFirst = videoChunkCache.keys().next();

        if (generalFirst.done && videoFirst.done) {
            break;
        }

        if (!generalFirst.done && !videoFirst.done) {
            const generalEntry = generalCache.get(generalFirst.value);
            const videoEntry = videoChunkCache.get(videoFirst.value);

            if ((generalEntry?.lastAccess || 0) <= (videoEntry?.lastAccess || 0)) {
                removeGeneralCache(generalFirst.value);
            } else {
                removeVideoChunk(videoFirst.value);
            }

            continue;
        }

        if (!generalFirst.done) {
            removeGeneralCache(generalFirst.value);
        } else {
            removeVideoChunk(videoFirst.value);
        }
    }
}


/* ============================================================
 * URL
 * ============================================================
 */

function getTargetUrl(request) {
    const incoming = new URL(request.url);
    const pathname = incoming.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

    return new URL(
        pathname + incoming.search,
        TARGET_ORIGIN
    );
}


/* ============================================================
 * General cache key
 * ============================================================
 */

function getGeneralCacheKey(request, targetUrl) {
    const acceptLanguage = request.headers.get('accept-language') || '';
    const userAgent = request.headers.get('user-agent') || '';

    return [
        targetUrl.href,
        `lang=${acceptLanguage}`,
        `ua=${userAgent}`
    ].join('|');
}


/* ============================================================
 * Request headers -> Origin
 * ============================================================
 *
 * IMPORTANT:
 *   Cookie and Authorization are forwarded.
 */

function buildTargetRequestHeaders(request, incomingUrl, options = {}) {
    const headers = new Headers();
    const proxyOrigin = incomingUrl?.origin || null;

    for (const [name, value] of request.headers) {
        const lower = name.toLowerCase();

        if (HOP_BY_HOP.has(lower)) {
            continue;
        }

        if (lower === 'host') {
            continue;
        }

        if (lower === 'accept-encoding') {
            continue;
        }

        if (lower === 'range') {
            continue;
        }

        /* Proxy Origin -> Target Origin */
        if (lower === 'origin') {
            try {
                const origin = new URL(value);

                if (!proxyOrigin || origin.origin === proxyOrigin) {
                    headers.set('origin', TARGET.origin);
                    continue;
                }
            } catch {
                /* Keep original value below. */
            }
        }

        /* Proxy Referer -> Target Referer */
        if (lower === 'referer') {
            try {
                const referer = new URL(value);

                if (!proxyOrigin || referer.origin === proxyOrigin) {
                    headers.set(
                        'referer',
                        new URL(
                            referer.pathname +
                            referer.search +
                            referer.hash,
                            TARGET_ORIGIN
                        ).href
                    );
                    continue;
                }
            } catch {
                /* Keep original value below. */
            }
        }

        /*
         * Cookie, Authorization, User-Agent, Accept, etc.
         * are intentionally preserved.
         */
        headers.set(name, value);
    }

    headers.set('host', TARGET.host);
    headers.set('accept-encoding', 'identity');

    if (options.range) {
        headers.set('range', options.range);
    }

    return headers;
}


/* ============================================================
 * Origin response headers -> client
 * ============================================================
 */

function buildResponseHeaders(upstream, incomingUrl) {
    const headers = new Headers();
    const cookies = [];
    const proxyOrigin = incomingUrl.origin;

    for (const [name, value] of upstream.headers) {
        const lower = name.toLowerCase();

        if (HOP_BY_HOP.has(lower)) {
            continue;
        }

        if (lower === 'set-cookie') {
            /* Preserve each cookie separately when possible. */
            if (typeof upstream.headers.getSetCookie !== 'function') {
                cookies.push(value);
            }
            continue;
        }

        if (lower === 'location') {
            try {
                const location = new URL(value, TARGET_ORIGIN);

                if (location.origin === TARGET.origin) {
                    headers.set(
                        'location',
                        new URL(
                            location.pathname +
                            location.search +
                            location.hash,
                            proxyOrigin
                        ).href
                    );
                    continue;
                }
            } catch {
                /* Keep original location. */
            }
        }

        headers.append(name, value);
    }

    if (typeof upstream.headers.getSetCookie === 'function') {
        for (const cookie of upstream.headers.getSetCookie()) {
            headers.append('set-cookie', cookie);
        }
    } else {
        for (const cookie of cookies) {
            headers.append('set-cookie', cookie);
        }
    }

    return headers;
}


/* ============================================================
 * Parse Range
 * ============================================================
 */

function parseRangeHeader(value) {
    if (!value) {
        return null;
    }

    const raw = value.trim();

    /* One range only. */
    const normal = /^bytes=(\d+)-(\d*)$/i.exec(raw);

    if (normal) {
        const start = Number(normal[1]);
        const end = normal[2] === '' ? null : Number(normal[2]);

        if (!Number.isSafeInteger(start) || start < 0) {
            return null;
        }

        if (
            end !== null &&
            (!Number.isSafeInteger(end) || end < start)
        ) {
            return null;
        }

        return {
            kind: 'normal',
            start,
            end
        };
    }

    const suffix = /^bytes=-(\d+)$/i.exec(raw);

    if (suffix) {
        const length = Number(suffix[1]);

        if (!Number.isSafeInteger(length) || length <= 0) {
            return null;
        }

        return {
            kind: 'suffix',
            length
        };
    }

    return null;
}


/* ============================================================
 * Parse Content-Range
 * ============================================================
 */

function parseContentRange(value) {
    if (!value) {
        return null;
    }

    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(
        value.trim()
    );

    if (!match) {
        return null;
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === '*' ? null : Number(match[3]);

    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end < start
    ) {
        return null;
    }

    if (
        total !== null &&
        (!Number.isSafeInteger(total) || total <= 0 || end >= total)
    ) {
        return null;
    }

    return {
        start,
        end,
        total
    };
}


/* ============================================================
 * Video metadata
 * ============================================================
 */

function getCachedVideoMeta(targetUrl) {
    const key = targetUrl.href;
    const entry = videoMetaCache.get(key);

    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= now()) {
        videoMetaCache.delete(key);
        return null;
    }

    touchCache(videoMetaCache, key, entry);
    return entry;
}


function setVideoMeta(targetUrl, totalLength, contentType) {
    if (!isSafePositiveInteger(totalLength)) {
        return;
    }

    videoMetaCache.set(targetUrl.href, {
        totalLength,
        contentType: contentType || 'video/mp4',
        expiresAt: now() + VIDEO_CACHE_TTL,
        lastAccess: now()
    });
}


/* ============================================================
 * Video chunks
 * ============================================================
 */

function getVideoChunkKey(targetUrl, chunkIndex) {
    return `${targetUrl.href}|chunk=${chunkIndex}`;
}


function getCachedVideoChunk(targetUrl, chunkIndex) {
    const key = getVideoChunkKey(targetUrl, chunkIndex);
    const entry = videoChunkCache.get(key);

    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= now()) {
        removeVideoChunk(key);
        return null;
    }

    touchCache(videoChunkCache, key, entry);
    return entry;
}


function storeVideoChunk(
    targetUrl,
    chunkIndex,
    data,
    {
        start,
        end,
        totalLength = null,
        contentType = 'video/mp4'
    }
) {
    const key = getVideoChunkKey(targetUrl, chunkIndex);
    const old = videoChunkCache.get(key);

    if (old) {
        removeVideoChunk(key);
    }

    const source =
        data instanceof Uint8Array
            ? data
            : new Uint8Array(data);

    const body = new Uint8Array(source.byteLength);
    body.set(source);

    const entry = {
        body,
        size: body.byteLength,
        start,
        end,
        totalLength: Number.isSafeInteger(totalLength)
            ? totalLength
            : null,
        contentType: contentType || 'video/mp4',
        chunkIndex,
        expiresAt: now() + VIDEO_CACHE_TTL,
        lastAccess: now()
    };

    videoChunkCache.set(key, entry);
    cacheTotalSize += entry.size;
    enforceGlobalMemoryLimit();

    debugVideo(
        'CACHE STORE',
        `chunk=${chunkIndex}`,
        `${start}-${end}`,
        `${Math.round(entry.size / 1024)}KB`
    );

    return entry;
}


function isRangeFullyCached(targetUrl, start, end) {
    const firstChunk = Math.floor(start / VIDEO_CHUNK_SIZE);
    const lastChunk = Math.floor(end / VIDEO_CHUNK_SIZE);

    for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex++) {
        const entry = getCachedVideoChunk(targetUrl, chunkIndex);

        if (!entry) {
            return false;
        }

        if (entry.start > start && chunkIndex === firstChunk) {
            return false;
        }

        if (entry.end < end && chunkIndex === lastChunk) {
            return false;
        }

        if (entry.start > end || entry.end < start) {
            return false;
        }
    }

    return true;
}


/* ============================================================
 * Cached video stream
 * ============================================================
 */

function createCachedVideoStream(targetUrl, start, end) {
    const firstChunk = Math.floor(start / VIDEO_CHUNK_SIZE);
    const lastChunk = Math.floor(end / VIDEO_CHUNK_SIZE);

    let chunkIndex = firstChunk;
    let currentEntry = null;
    let currentOffset = 0;
    let currentEnd = 0;

    return new ReadableStream({
        async pull(controller) {
            try {
                while (true) {
                    if (!currentEntry) {
                        if (chunkIndex > lastChunk) {
                            controller.close();
                            return;
                        }

                        currentEntry = getCachedVideoChunk(
                            targetUrl,
                            chunkIndex
                        );

                        if (!currentEntry) {
                            controller.error(
                                new Error(
                                    'Video cache entry vanished while serving'
                                )
                            );
                            return;
                        }

                        currentOffset = Math.max(
                            start - currentEntry.start,
                            0
                        );

                        currentEnd = Math.min(
                            end - currentEntry.start + 1,
                            currentEntry.body.byteLength
                        );
                    }

                    if (currentOffset >= currentEnd) {
                        currentEntry = null;
                        chunkIndex++;
                        continue;
                    }

                    const pieceEnd = Math.min(
                        currentOffset + CACHE_STREAM_PIECE_SIZE,
                        currentEnd
                    );

                    const piece = currentEntry.body.subarray(
                        currentOffset,
                        pieceEnd
                    );

                    currentOffset = pieceEnd;

                    controller.enqueue(piece);
                    return;
                }
            } catch (error) {
                controller.error(error);
            }
        }
    });
}


/* ============================================================
 * Cache writer for a streaming response
 * ============================================================
 *
 * Only full global 2 MiB chunks are cached, plus the final short chunk
 * when we know the stream really reached the end of the video.
 */

class VideoChunkWriter {
    constructor(targetUrl, totalLength, contentType) {
        this.targetUrl = targetUrl;
        this.totalLength = Number.isSafeInteger(totalLength)
            ? totalLength
            : null;
        this.contentType = contentType || 'video/mp4';
        this.pending = null;
    }

    write(data, absoluteStart) {
        let offset = 0;

        while (offset < data.byteLength) {
            const absolute = absoluteStart + offset;
            const chunkIndex = Math.floor(
                absolute / VIDEO_CHUNK_SIZE
            );
            const chunkStart =
                chunkIndex * VIDEO_CHUNK_SIZE;

            /* Skip an incomplete prefix before the next global chunk boundary. */
            if (!this.pending && absolute !== chunkStart) {
                const skip = Math.min(
                    data.byteLength - offset,
                    VIDEO_CHUNK_SIZE -
                    (absolute - chunkStart)
                );

                offset += skip;
                continue;
            }

            if (!this.pending || this.pending.chunkIndex !== chunkIndex) {
                const expectedSize = Number.isSafeInteger(this.totalLength)
                    ? Math.min(
                        VIDEO_CHUNK_SIZE,
                        this.totalLength - chunkStart
                    )
                    : VIDEO_CHUNK_SIZE;

                if (expectedSize <= 0) {
                    break;
                }

                this.pending = {
                    chunkIndex,
                    start: chunkStart,
                    body: new Uint8Array(expectedSize),
                    filled: 0
                };
            }

            const remaining =
                this.pending.body.byteLength -
                this.pending.filled;

            const take = Math.min(
                remaining,
                data.byteLength - offset
            );

            this.pending.body.set(
                data.subarray(offset, offset + take),
                this.pending.filled
            );

            this.pending.filled += take;
            offset += take;

            if (
                this.pending.filled ===
                this.pending.body.byteLength
            ) {
                this.commitPending();
            }
        }
    }

    commitPending() {
        if (!this.pending) {
            return;
        }

        const pending = this.pending;

        if (!getCachedVideoChunk(this.targetUrl, pending.chunkIndex)) {
            storeVideoChunk(
                this.targetUrl,
                pending.chunkIndex,
                pending.body,
                {
                    start: pending.start,
                    end:
                        pending.start +
                        pending.body.byteLength -
                        1,
                    totalLength: this.totalLength,
                    contentType: this.contentType
                }
            );
        }

        this.pending = null;
    }

    finish(resourceEof) {
        if (
            resourceEof &&
            this.pending &&
            this.pending.filled > 0
        ) {
            const pending = this.pending;

            if (!getCachedVideoChunk(this.targetUrl, pending.chunkIndex)) {
                storeVideoChunk(
                    this.targetUrl,
                    pending.chunkIndex,
                    pending.body.subarray(
                        0,
                        pending.filled
                    ),
                    {
                        start: pending.start,
                        end:
                            pending.start +
                            pending.filled -
                            1,
                        totalLength: this.totalLength,
                        contentType: this.contentType
                    }
                );
            }
        }

        this.pending = null;
    }
}


/* ============================================================
 * Streaming Origin Range response
 * ============================================================
 */

async function createOriginStreamingResponse({
    request,
    incomingUrl,
    targetUrl,
    originRange,
    requestedStart,
    requestedEnd = null
}) {
    const requestHeaders = buildTargetRequestHeaders(
        request,
        incomingUrl,
        { range: originRange }
    );

    debugVideo('ORIGIN REQUEST', originRange);

    const upstream = await fetch(
        targetUrl,
        {
            method: 'GET',
            headers: requestHeaders,
            redirect: 'manual'
        }
    );

    /* ========================================================
     * Origin supports Range
     * ======================================================== */

    if (upstream.status === 206) {
        if (!upstream.body) {
            throw new Error(
                'Origin returned 206 without body'
            );
        }

        const contentRange = parseContentRange(
            upstream.headers.get('content-range')
        );

        if (!contentRange) {
            throw new Error(
                'Origin returned 206 without valid Content-Range'
            );
        }

        if (contentRange.start !== requestedStart) {
            throw new Error(
                `Origin returned unexpected range start: ${contentRange.start}`
            );
        }

        const totalLength = contentRange.total;
        const contentType =
            upstream.headers.get('content-type') ||
            'video/mp4';

        if (Number.isSafeInteger(totalLength)) {
            setVideoMeta(
                targetUrl,
                totalLength,
                contentType
            );
        }

        /*
         * Origin should normally return exactly what we asked for.
         * Still, clamp the client-visible range so the proxy never returns
         * more bytes than the client's Range requested.
         */
        const clientStart = contentRange.start;
        const clientEnd =
            requestedEnd === null
                ? contentRange.end
                : Math.min(requestedEnd, contentRange.end);

        if (clientEnd < clientStart) {
            try {
                await upstream.body.cancel();
            } catch {}

            throw new Error(
                `Origin returned invalid range ${contentRange.start}-${contentRange.end}`
            );
        }

        const finalHeaders = buildResponseHeaders(
            upstream,
            incomingUrl
        );

        finalHeaders.set('accept-ranges', 'bytes');
        finalHeaders.set(
            'content-range',
            `bytes ${clientStart}-${clientEnd}/` +
            `${Number.isSafeInteger(totalLength) ? totalLength : '*'}`
        );
        finalHeaders.set(
            'content-length',
            String(clientEnd - clientStart + 1)
        );
        finalHeaders.set('content-type', contentType);
        finalHeaders.set('cache-control', 'public, max-age=30');
        finalHeaders.delete('content-encoding');
        finalHeaders.delete('transfer-encoding');

        const reader = upstream.body.getReader();
        const writer = new VideoChunkWriter(
            targetUrl,
            totalLength,
            contentType
        );

        let sourcePosition = contentRange.start;
        let closed = false;

        const nextChunkIndex = Math.floor(
            (contentRange.end + 1) /
            VIDEO_CHUNK_SIZE
        );

        const stream = new ReadableStream({
            async pull(controller) {
                if (closed) {
                    controller.close();
                    return;
                }

                try {
                    const { done, value } = await reader.read();

                    if (done) {
                        closed = true;

                        const resourceEof =
                            Number.isSafeInteger(totalLength) &&
                            contentRange.end >= totalLength - 1;

                        writer.finish(resourceEof);

                        if (sourcePosition < clientEnd + 1) {
                            controller.error(
                                new Error(
                                    `Origin ended early: ${sourcePosition}/${clientEnd + 1}`
                                )
                            );
                            return;
                        }

                        controller.close();

                        if (VIDEO_READ_AHEAD > 0) {
                            scheduleVideoReadAhead(
                                request,
                                incomingUrl,
                                targetUrl,
                                nextChunkIndex,
                                totalLength
                            );
                        }

                        return;
                    }

                    if (!value || value.byteLength === 0) {
                        return;
                    }

                    const absoluteStart = sourcePosition;
                    const absoluteEnd =
                        sourcePosition + value.byteLength - 1;

                    writer.write(
                        value,
                        sourcePosition
                    );

                    sourcePosition += value.byteLength;

                    /*
                     * Stream only the part requested by the client.
                     * The cache writer still sees the original absolute data.
                     */
                    const sendStart = Math.max(
                        absoluteStart,
                        clientStart
                    );

                    const sendEnd = Math.min(
                        absoluteEnd,
                        clientEnd
                    );

                    if (sendStart <= sendEnd) {
                        const offset = sendStart - absoluteStart;
                        const length = sendEnd - sendStart + 1;

                        controller.enqueue(
                            value.subarray(
                                offset,
                                offset + length
                            )
                        );
                    }

                    /*
                     * Requested client range complete.
                     */
                    if (
                        absoluteEnd >=
                        clientEnd
                    ) {
                        closed = true;

                        try {
                            await reader.cancel();
                        } catch {}

                        writer.finish(
                            Number.isSafeInteger(totalLength) &&
                            contentRange.end >= totalLength - 1
                        );

                        controller.close();

                        if (VIDEO_READ_AHEAD > 0) {
                            scheduleVideoReadAhead(
                                request,
                                incomingUrl,
                                targetUrl,
                                nextChunkIndex,
                                totalLength
                            );
                        }
                    }
                } catch (error) {
                    closed = true;
                    controller.error(error);

                    try {
                        await reader.cancel(error);
                    } catch {}
                }
            },

            async cancel(reason) {
                closed = true;

                try {
                    await reader.cancel(reason);
                } catch {}
            }
        });

        debugVideo(
            'STREAM 206',
            `${contentRange.start}-${contentRange.end}`,
            `total=${contentRange.total ?? '?'}`
        );

        return new Response(
            stream,
            {
                status: 206,
                statusText: 'Partial Content',
                headers: finalHeaders
            }
        );
    }


    /* ========================================================
     * Range ignored: Origin returned 200
     * ========================================================
     *
     * We don't buffer the whole video.
     * We consume the Origin stream and only enqueue the requested
     * byte range to the client.
     */

    if (upstream.status === 200) {
        if (!upstream.body) {
            throw new Error(
                'Origin returned 200 without body'
            );
        }

        const contentType =
            upstream.headers.get('content-type') ||
            'video/mp4';

        const rawLength = Number(
            upstream.headers.get('content-length')
        );

        const totalLength = isSafePositiveInteger(rawLength)
            ? rawLength
            : null;

        if (!Number.isSafeInteger(totalLength) && requestedEnd === null) {
            /*
             * A 200 body with no length cannot provide a valid Content-Range
             * header for an open-ended non-zero range without buffering to EOF.
             * Real hx.rstp.jp Range responses do not need this fallback.
             */
            try {
                await upstream.body.cancel();
            } catch {}

            throw new Error(
                'Origin returned 200 without Content-Length for open-ended Range'
            );
        }

        let rangeStart = requestedStart;
        let rangeEnd = requestedEnd;

        if (
            Number.isSafeInteger(totalLength)
        ) {
            if (rangeStart >= totalLength) {
                try {
                    await upstream.body.cancel();
                } catch {}

                return new Response(null, {
                    status: 416,
                    headers: {
                        'content-range': `bytes */${totalLength}`,
                        'accept-ranges': 'bytes',
                        'cache-control': 'no-store'
                    }
                });
            }

            if (rangeEnd === null) {
                rangeEnd = totalLength - 1;
            } else {
                rangeEnd = Math.min(
                    rangeEnd,
                    totalLength - 1
                );
            }

            setVideoMeta(
                targetUrl,
                totalLength,
                contentType
            );
        }

        if (rangeEnd === null || rangeEnd < rangeStart) {
            try {
                await upstream.body.cancel();
            } catch {}

            throw new Error(
                'Unable to resolve 200 fallback Range'
            );
        }

        const finalHeaders = buildResponseHeaders(
            upstream,
            incomingUrl
        );

        finalHeaders.set('accept-ranges', 'bytes');
        finalHeaders.set('content-type', contentType);
        finalHeaders.set(
            'content-range',
            `bytes ${rangeStart}-${rangeEnd}/` +
            `${Number.isSafeInteger(totalLength) ? totalLength : '*'}`
        );
        finalHeaders.set(
            'content-length',
            String(rangeEnd - rangeStart + 1)
        );
        finalHeaders.set('cache-control', 'public, max-age=30');
        finalHeaders.delete('content-encoding');
        finalHeaders.delete('transfer-encoding');

        const reader = upstream.body.getReader();
        const writer = new VideoChunkWriter(
            targetUrl,
            totalLength,
            contentType
        );

        let sourcePosition = 0;
        let closed = false;

        const nextChunkIndex = Math.floor(
            (rangeEnd + 1) /
            VIDEO_CHUNK_SIZE
        );

        const stream = new ReadableStream({
            async pull(controller) {
                if (closed) {
                    controller.close();
                    return;
                }

                try {
                    const { done, value } = await reader.read();

                    if (done) {
                        closed = true;
                        writer.finish(true);

                        if (sourcePosition <= rangeEnd) {
                            controller.error(
                                new Error(
                                    `Origin ended before requested range: ${sourcePosition}/${rangeEnd + 1}`
                                )
                            );
                            return;
                        }

                        controller.close();
                        return;
                    }

                    if (!value || value.byteLength === 0) {
                        return;
                    }

                    const absoluteStart = sourcePosition;
                    const absoluteEnd =
                        sourcePosition + value.byteLength - 1;

                    /* Cache the original resource at absolute positions. */
                    writer.write(
                        value,
                        absoluteStart
                    );

                    sourcePosition += value.byteLength;

                    /* Send only requested bytes to the client. */
                    const overlapStart = Math.max(
                        absoluteStart,
                        rangeStart
                    );

                    const overlapEnd = Math.min(
                        absoluteEnd,
                        rangeEnd
                    );

                    if (overlapStart <= overlapEnd) {
                        const offset = overlapStart - absoluteStart;
                        const length = overlapEnd - overlapStart + 1;

                        controller.enqueue(
                            value.subarray(
                                offset,
                                offset + length
                            )
                        );
                    }

                    if (absoluteEnd >= rangeEnd) {
                        closed = true;

                        try {
                            await reader.cancel();
                        } catch {}

                        writer.finish(
                            Number.isSafeInteger(totalLength) &&
                            rangeEnd >= totalLength - 1 &&
                            sourcePosition >= totalLength
                        );

                        controller.close();

                        if (VIDEO_READ_AHEAD > 0) {
                            scheduleVideoReadAhead(
                                request,
                                incomingUrl,
                                targetUrl,
                                nextChunkIndex,
                                totalLength
                            );
                        }
                    }
                } catch (error) {
                    closed = true;
                    controller.error(error);

                    try {
                        await reader.cancel(error);
                    } catch {}
                }
            },

            async cancel(reason) {
                closed = true;

                try {
                    await reader.cancel(reason);
                } catch {}
            }
        });

        debugVideo(
            'STREAM 200 FALLBACK',
            `${rangeStart}-${rangeEnd}`,
            `total=${totalLength ?? '?'}`
        );

        return new Response(
            stream,
            {
                status: 206,
                statusText: 'Partial Content',
                headers: finalHeaders
            }
        );
    }

    throw new Error(
        `Origin returned HTTP ${upstream.status} for video Range`
    );
}


/* ============================================================
 * Background read-ahead
 * ============================================================
 *
 * This is deliberately one 2 MiB internal Range request.
 * It is not used for the current client response.
 */

function scheduleVideoReadAhead(
    request,
    incomingUrl,
    targetUrl,
    chunkIndex,
    totalLength
) {
    if (VIDEO_READ_AHEAD <= 0) {
        return;
    }

    const start = chunkIndex * VIDEO_CHUNK_SIZE;

    if (
        Number.isSafeInteger(totalLength) &&
        start >= totalLength
    ) {
        return;
    }

    if (getCachedVideoChunk(targetUrl, chunkIndex)) {
        return;
    }

    const key = getVideoChunkKey(
        targetUrl,
        chunkIndex
    );

    if (videoPrefetchInflight.has(key)) {
        return;
    }

    const end = Number.isSafeInteger(totalLength)
        ? Math.min(
            start + VIDEO_CHUNK_SIZE - 1,
            totalLength - 1
        )
        : start + VIDEO_CHUNK_SIZE - 1;

    const task = (async () => {
        try {
            const headers = buildTargetRequestHeaders(
                request,
                incomingUrl,
                {
                    range: `bytes=${start}-${end}`
                }
            );

            debugVideo(
                'READ AHEAD',
                `${start}-${end}`
            );

            const upstream = await fetch(
                targetUrl,
                {
                    method: 'GET',
                    headers,
                    redirect: 'manual'
                }
            );

            if (
                upstream.status !== 206 ||
                !upstream.body
            ) {
                try {
                    await upstream.body?.cancel();
                } catch {}
                return;
            }

            const contentRange = parseContentRange(
                upstream.headers.get('content-range')
            );

            if (!contentRange || contentRange.start !== start) {
                try {
                    await upstream.body.cancel();
                } catch {}
                return;
            }

            const finalTotal =
                contentRange.total ?? totalLength;

            const contentType =
                upstream.headers.get('content-type') ||
                'video/mp4';

            if (Number.isSafeInteger(finalTotal)) {
                setVideoMeta(
                    targetUrl,
                    finalTotal,
                    contentType
                );
            }

            const reader = upstream.body.getReader();
            const writer = new VideoChunkWriter(
                targetUrl,
                finalTotal,
                contentType
            );

            let position = contentRange.start;

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        writer.finish(
                            Number.isSafeInteger(finalTotal) &&
                            contentRange.end >= finalTotal - 1
                        );
                        break;
                    }

                    if (!value || value.byteLength === 0) {
                        continue;
                    }

                    writer.write(value, position);
                    position += value.byteLength;
                }
            } finally {
                try {
                    reader.releaseLock();
                } catch {}
            }
        } catch (error) {
            if (process.env.DEBUG_VIDEO === '1') {
                console.error('[VIDEO READ AHEAD ERROR]', error);
            }
        }
    })();

    videoPrefetchInflight.set(key, task);

    waitUntil(task);

    task.finally(() => {
        videoPrefetchInflight.delete(key);
    });
}


/* ============================================================
 * Video Range handler
 * ============================================================
 */

async function handleVideoRangeRequest(
    request,
    incomingUrl,
    targetUrl
) {
    const parsed = parseRangeHeader(
        request.headers.get('range')
    );

    if (!parsed) {
        return new Response('Invalid Range', {
            status: 416,
            headers: {
                'accept-ranges': 'bytes',
                'cache-control': 'no-store'
            }
        });
    }

    let meta = getCachedVideoMeta(targetUrl);

    /* --------------------------------------------------------
     * Suffix range
     * -------------------------------------------------------- */

    if (parsed.kind === 'suffix') {
        if (!meta) {
            /*
             * Keep this uncommon case simple and correct: ask Origin for
             * bytes=0- to learn the size, then stream the final suffix from
             * that response without buffering the whole body.
             */
            const requestHeaders = buildTargetRequestHeaders(
                request,
                incomingUrl,
                {
                    range: 'bytes=0-'
                }
            );

            const upstream = await fetch(
                targetUrl,
                {
                    method: 'GET',
                    headers: requestHeaders,
                    redirect: 'manual'
                }
            );

            if (upstream.status !== 206 || !upstream.body) {
                try {
                    await upstream.body?.cancel();
                } catch {}

                return new Response(
                    'Unable to resolve suffix Range',
                    {
                        status: 416,
                        headers: {
                            'accept-ranges': 'bytes',
                            'cache-control': 'no-store'
                        }
                    }
                );
            }

            const contentRange = parseContentRange(
                upstream.headers.get('content-range')
            );

            if (
                !contentRange ||
                !Number.isSafeInteger(contentRange.total)
            ) {
                try {
                    await upstream.body.cancel();
                } catch {}

                return new Response(
                    'Unable to determine video length',
                    {
                        status: 416,
                        headers: {
                            'accept-ranges': 'bytes',
                            'cache-control': 'no-store'
                        }
                    }
                );
            }

            const total = contentRange.total;
            const length = Math.min(parsed.length, total);
            const start = total - length;
            const end = total - 1;

            setVideoMeta(
                targetUrl,
                total,
                upstream.headers.get('content-type') || 'video/mp4'
            );

            return createExisting206SuffixStream(
                incomingUrl,
                targetUrl,
                upstream,
                start,
                end,
                contentRange
            );
        }

        const total = meta.totalLength;
        const length = Math.min(parsed.length, total);
        const start = total - length;
        const end = total - 1;

        if (isRangeFullyCached(targetUrl, start, end)) {
            return createCachedVideoResponse(
                targetUrl,
                start,
                end,
                total,
                meta.contentType
            );
        }

        return createOriginStreamingResponse({
            request,
            incomingUrl,
            targetUrl,
            originRange: `bytes=${start}-${end}`,
            requestedStart: start,
            requestedEnd: end
        });
    }


    /* --------------------------------------------------------
     * Normal range
     * -------------------------------------------------------- */

    const start = parsed.start;
    let end = parsed.end;

    if (meta) {
        if (start >= meta.totalLength) {
            return new Response(null, {
                status: 416,
                headers: {
                    'content-range': `bytes */${meta.totalLength}`,
                    'accept-ranges': 'bytes',
                    'cache-control': 'no-store'
                }
            });
        }

        if (end === null) {
            end = meta.totalLength - 1;
        } else {
            end = Math.min(end, meta.totalLength - 1);
        }
    }

    /*
     * Open-ended Range with unknown total: preserve it exactly.
     * Origin's Content-Range tells the client the actual end/total.
     */
    if (end === null) {
        return createOriginStreamingResponse({
            request,
            incomingUrl,
            targetUrl,
            originRange: `bytes=${start}-`,
            requestedStart: start,
            requestedEnd: null
        });
    }

    if (end < start) {
        return new Response(null, {
            status: 416,
            headers: {
                'accept-ranges': 'bytes',
                'cache-control': 'no-store'
            }
        });
    }

    /* --------------------------------------------------------
     * Full cache hit
     * -------------------------------------------------------- */

    if (
        meta &&
        isRangeFullyCached(targetUrl, start, end)
    ) {
        debugVideo(
            'CACHE HIT',
            `${start}-${end}`
        );

        return createCachedVideoResponse(
            targetUrl,
            start,
            end,
            meta.totalLength,
            meta.contentType
        );
    }

    /*
     * Cache miss:
     * ONE Origin Range request, streamed directly to client.
     * The response Range is NOT reduced to 2 MiB.
     */
    debugVideo(
        'CACHE MISS',
        `${start}-${end}`
    );

    return createOriginStreamingResponse({
        request,
        incomingUrl,
        targetUrl,
        originRange: `bytes=${start}-${end}`,
        requestedStart: start,
        requestedEnd: end
    });
}


/* ============================================================
 * Existing 206 -> suffix client response
 * ============================================================
 */

function createExisting206SuffixStream(
    incomingUrl,
    targetUrl,
    upstream,
    requestedStart,
    requestedEnd,
    contentRange
) {
    const totalLength = contentRange.total;
    const contentType =
        upstream.headers.get('content-type') ||
        'video/mp4';

    const headers = buildResponseHeaders(
        upstream,
        incomingUrl
    );

    headers.set('accept-ranges', 'bytes');
    headers.set('content-type', contentType);
    headers.set(
        'content-range',
        `bytes ${requestedStart}-${requestedEnd}/${totalLength}`
    );
    headers.set(
        'content-length',
        String(requestedEnd - requestedStart + 1)
    );
    headers.set('cache-control', 'public, max-age=30');
    headers.delete('content-encoding');
    headers.delete('transfer-encoding');

    const reader = upstream.body.getReader();
    const writer = new VideoChunkWriter(
        targetUrl,
        totalLength,
        contentType
    );

    let sourcePosition = contentRange.start;
    let closed = false;

    const stream = new ReadableStream({
        async pull(controller) {
            if (closed) {
                controller.close();
                return;
            }

            try {
                const { done, value } = await reader.read();

                if (done) {
                    closed = true;
                    writer.finish(
                        contentRange.end >= totalLength - 1
                    );
                    controller.close();
                    return;
                }

                if (!value || value.byteLength === 0) {
                    return;
                }

                const absoluteStart = sourcePosition;
                const absoluteEnd =
                    sourcePosition + value.byteLength - 1;

                writer.write(value, sourcePosition);
                sourcePosition += value.byteLength;

                const overlapStart = Math.max(
                    absoluteStart,
                    requestedStart
                );

                const overlapEnd = Math.min(
                    absoluteEnd,
                    requestedEnd
                );

                if (overlapStart <= overlapEnd) {
                    const offset = overlapStart - absoluteStart;
                    const length = overlapEnd - overlapStart + 1;

                    controller.enqueue(
                        value.subarray(
                            offset,
                            offset + length
                        )
                    );
                }

                if (absoluteEnd >= requestedEnd) {
                    closed = true;

                    try {
                        await reader.cancel();
                    } catch {}

                    writer.finish(
                        contentRange.end >= totalLength - 1
                    );

                    controller.close();
                }
            } catch (error) {
                closed = true;
                controller.error(error);

                try {
                    await reader.cancel(error);
                } catch {}
            }
        },

        async cancel(reason) {
            closed = true;

            try {
                await reader.cancel(reason);
            } catch {}
        }
    });

    return new Response(
        stream,
        {
            status: 206,
            statusText: 'Partial Content',
            headers
        }
    );
}


/* ============================================================
 * Cached response
 * ============================================================
 */

function createCachedVideoResponse(
    targetUrl,
    start,
    end,
    totalLength,
    contentType
) {
    const headers = new Headers();

    headers.set('accept-ranges', 'bytes');
    headers.set('content-type', contentType || 'video/mp4');
    headers.set('content-length', String(end - start + 1));
    headers.set(
        'content-range',
        `bytes ${start}-${end}/${totalLength}`
    );
    headers.set('cache-control', 'public, max-age=30');

    return new Response(
        createCachedVideoStream(
            targetUrl,
            start,
            end
        ),
        {
            status: 206,
            statusText: 'Partial Content',
            headers
        }
    );
}


/* ============================================================
 * General cache
 * ============================================================
 */

function getGeneralCache(key) {
    const entry = generalCache.get(key);

    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= now()) {
        removeGeneralCache(key);
        return null;
    }

    touchCache(generalCache, key, entry);
    return entry;
}


function responseFromGeneralCache(request, entry) {
    return new Response(
        request.method === 'HEAD'
            ? null
            : entry.body.slice(0),
        {
            status: entry.status,
            headers: new Headers(entry.headers)
        }
    );
}


function canStoreGeneralResponse(request, response) {
    if (
        request.method !== 'GET' &&
        request.method !== 'HEAD'
    ) {
        return false;
    }

    if (response.status !== 200) {
        return false;
    }

    const cacheControl =
        (response.headers.get('cache-control') || '').toLowerCase();

    if (
        cacheControl.includes('no-store') ||
        cacheControl.includes('private') ||
        cacheControl.includes('no-cache')
    ) {
        return false;
    }

    if (response.headers.has('set-cookie')) {
        return false;
    }

    return true;
}


/* ============================================================
 * General Origin fetch
 * ============================================================
 */

async function fetchGeneral(request, incomingUrl, targetUrl) {
    const headers = buildTargetRequestHeaders(
        request,
        incomingUrl
    );

    const response = await fetch(
        targetUrl,
        {
            method: request.method,
            headers,
            body:
                request.method !== 'GET' &&
                request.method !== 'HEAD'
                    ? request.body
                    : undefined,
            redirect: 'manual'
        }
    );

    return {
        response,
        headers: buildResponseHeaders(
            response,
            incomingUrl
        )
    };
}


/* ============================================================
 * Bun server
 * ============================================================
 */



/* ============================================================
 * Vercel Function handler
 * ============================================================
 */

async function handler(request) {
        const incomingUrl = new URL(request.url);
        const targetUrl = getTargetUrl(request);

        try {
            /* ------------------------------------------------
             * Video Range
             * ------------------------------------------------ */
            if (
                request.method === 'GET' &&
                request.headers.has('range')
            ) {
                return await handleVideoRangeRequest(
                    request,
                    incomingUrl,
                    targetUrl
                );
            }

            /* ------------------------------------------------
             * General request
             * ------------------------------------------------ */
            const canCache =
                request.method === 'GET' ||
                request.method === 'HEAD';

            const cacheKey = canCache
                ? getGeneralCacheKey(request, targetUrl)
                : null;

            /* Cache hit */
            if (canCache) {
                const cached = getGeneralCache(cacheKey);

                if (cached) {
                    return responseFromGeneralCache(
                        request,
                        cached
                    );
                }
            }

            /* In-flight coalescing */
            if (
                canCache &&
                inflight.has(cacheKey)
            ) {
                try {
                    await inflight.get(cacheKey);
                } catch {
                    /* Retry below. */
                }

                const cached = getGeneralCache(cacheKey);

                if (cached) {
                    return responseFromGeneralCache(
                        request,
                        cached
                    );
                }
            }

            const fetchTask = fetchGeneral(
                request,
                incomingUrl,
                targetUrl
            );

            if (canCache) {
                inflight.set(cacheKey, fetchTask);
            }

            let result;

            try {
                result = await fetchTask;
            } finally {
                if (canCache) {
                    inflight.delete(cacheKey);
                }
            }

            const { response, headers } = result;

            /* ------------------------------------------------
             * General cache store
             * ------------------------------------------------ */
            if (
                canStoreGeneralResponse(
                    request,
                    response
                )
            ) {
                const contentLength = Number(
                    response.headers.get('content-length')
                );

                if (
                    Number.isSafeInteger(contentLength) &&
                    contentLength > CACHE_MAX_SIZE
                ) {
                    return new Response(
                        request.method === 'HEAD'
                            ? null
                            : response.body,
                        {
                            status: response.status,
                            headers
                        }
                    );
                }

                const body = await response.arrayBuffer();

                if (body.byteLength <= CACHE_MAX_SIZE) {
                    const entry = {
                        status: response.status,
                        headers,
                        body,
                        size: body.byteLength,
                        expiresAt: now() + CACHE_TTL,
                        lastAccess: now()
                    };

                    const old = generalCache.get(cacheKey);

                    if (old) {
                        removeGeneralCache(cacheKey);
                    }

                    generalCache.set(cacheKey, entry);
                    cacheTotalSize += entry.size;
                    enforceGlobalMemoryLimit();

                    return responseFromGeneralCache(
                        request,
                        entry
                    );
                }

                return new Response(
                    request.method === 'HEAD'
                        ? null
                        : body,
                    {
                        status: response.status,
                        headers
                    }
                );
            }

            /* Non-cacheable response: stream it. */
            return new Response(
                request.method === 'HEAD'
                    ? null
                    : response.body,
                {
                    status: response.status,
                    headers
                }
            );
        } catch (error) {
            console.error('[PROXY ERROR]', error);

            return new Response(
                'Bad Gateway',
                {
                    status: 502,
                    headers: {
                        'content-type':
                            'text/plain; charset=utf-8',
                        'cache-control': 'no-store'
                    }
                }
            );
        }
    }

export default {
    fetch: handler
};



/* ============================================================
 * Cleanup
 * ============================================================
 */

setInterval(() => {
    const current = now();

    for (const [key, entry] of generalCache) {
        if (entry.expiresAt <= current) {
            removeGeneralCache(key);
        }
    }

    for (const [key, entry] of videoChunkCache) {
        if (entry.expiresAt <= current) {
            removeVideoChunk(key);
        }
    }

    for (const [key, entry] of videoMetaCache) {
        if (entry.expiresAt <= current) {
            videoMetaCache.delete(key);
        }
    }

    enforceGlobalMemoryLimit();
}, CACHE_CLEANUP_INTERVAL);


