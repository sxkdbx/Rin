import { like, or } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import type { DB } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { cache, feeds, friends, moments, users } from "../db/schema";
import { deleteStorageObjectAtKey, getStorageObject, putStorageObject } from "../utils/storage";

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

const BLOB_PATH_PREFIX = "/api/blob/";

function trimTrailingSlash(value: string) {
    return value.endsWith("/") ? value.slice(0, -1) : value;
}

// Accepts a raw storage key, a /api/blob/ URL, or an S3_ACCESS_HOST URL and
// returns the storage key (including folder prefix), or null when the input
// does not point at this site's own storage.
export function extractStorageKey(env: Env, input: string): string | null {
    const trimmed = input.trim().split("#")[0];
    if (!trimmed) {
        return null;
    }

    if (trimmed.startsWith(BLOB_PATH_PREFIX)) {
        return decodeURIComponent(trimmed.slice(BLOB_PATH_PREFIX.length)) || null;
    }

    if (!/^https?:\/\//i.test(trimmed)) {
        return trimmed.replace(/^\/+/, "") || null;
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }

    if (url.pathname.startsWith(BLOB_PATH_PREFIX)) {
        return decodeURIComponent(url.pathname.slice(BLOB_PATH_PREFIX.length)) || null;
    }

    if (env.S3_ACCESS_HOST) {
        const host = trimTrailingSlash(env.S3_ACCESS_HOST);
        if (trimmed.startsWith(`${host}/`)) {
            return trimmed.slice(host.length + 1).split("?")[0] || null;
        }
    }

    return null;
}

async function isStorageKeyReferenced(db: DB, filename: string): Promise<boolean> {
    const pattern = `%${filename}%`;

    const checks = await Promise.all([
        db.select({ id: feeds.id }).from(feeds)
            .where(or(like(feeds.content, pattern), like(feeds.summary, pattern))).limit(1),
        db.select({ id: moments.id }).from(moments).where(like(moments.content, pattern)).limit(1),
        db.select({ id: users.id }).from(users).where(like(users.avatar, pattern)).limit(1),
        db.select({ id: friends.id }).from(friends).where(like(friends.avatar, pattern)).limit(1),
        db.select({ id: cache.id }).from(cache).where(like(cache.value, pattern)).limit(1),
    ]);

    return checks.some(rows => rows.length > 0);
}

export function StorageService(): Hono {
    const app = new Hono();

    // POST /storage
    app.post('/', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');
        
        const body = await profileAsync(c, 'storage_parse', () => c.req.parseBody());
        const key = body.key as string;
        const file = body.file as File;
        
        if (!uid) {
            return c.text('Unauthorized', 401);
        }
        
        const suffix = key.includes(".") ? key.split('.').pop() : "";
        const fileBuffer = await profileAsync(c, 'storage_file_buffer', () => file.arrayBuffer());
        const hashArray = await profileAsync(c, 'storage_hash', () => crypto.subtle.digest(
            { name: 'SHA-1' },
            fileBuffer
        ));
        const hash = buf2hex(hashArray);
        const hashkey = `${hash}.${suffix}`;
        
        try {
            const result = await profileAsync(c, 'storage_put', () => putStorageObject(env, hashkey, file, file.type, new URL(c.req.url).origin));
            return c.json({ url: result.url });
        } catch (e: any) {
            console.error(e.message);
            const status = e.message?.includes('is not defined') ? 500 : 400;
            return c.text(e.message, status);
        }
    });

    // DELETE /storage?url=<image url or key>
    app.delete('/', async (c: AppContext) => {
        const uid = c.get('uid');
        if (!uid) {
            return c.text('Unauthorized', 401);
        }

        const env = c.get('env');
        const db = c.get('db');
        const input = c.req.query('url') ?? c.req.query('key') ?? '';
        const storageKey = extractStorageKey(env, input);

        if (!storageKey) {
            return c.text('URL does not point to this site\'s storage', 400);
        }

        const filename = storageKey.split('/').pop() ?? storageKey;
        if (!filename) {
            return c.text('Invalid storage key', 400);
        }

        try {
            const referenced = await profileAsync(c, 'storage_ref_check', () => isStorageKeyReferenced(db, filename));
            if (referenced) {
                return c.json({ deleted: false, reason: 'referenced' });
            }

            await profileAsync(c, 'storage_delete', () => deleteStorageObjectAtKey(env, storageKey));
            return c.json({ deleted: true });
        } catch (e: any) {
            console.error(e.message);
            return c.text(e.message, 500);
        }
    });

    return app;
}

export function BlobService(): Hono {
    const app = new Hono();

    app.get("/*", async (c: AppContext) => {
        const env = c.get("env");
        const key = c.req.path.replace(/^\/blob\/?/, "");

        if (!key) {
            return c.text("Blob key is required", 400);
        }

        try {
            const response = await profileAsync(c, "blob_fetch", () => getStorageObject(env, decodeURIComponent(key)));

            if (!response) {
                return c.text("Not found", 404);
            }

            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        } catch (error) {
            console.error("Blob fetch failed:", error);
            return c.text("Blob fetch failed", 500);
        }
    });

    return app;
}
