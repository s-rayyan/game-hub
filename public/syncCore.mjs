// Pure logic for syncing this origin's localStorage with a signed-in user's cloud saves.
// No Firebase or DOM imports here, so it can be unit-tested in Node (see test/syncCore.test.mjs).
//
// Model: every game is served from this same origin, so all their localStorage keys live side by
// side with the hub's own. Each synced key becomes one Firestore document. A per-device "base"
// remembers a hash of each key's value as of the last successful sync, which lets us tell
// "changed here" from "changed on another device".

export const MAX_VALUE_BYTES = 600_000; // Firestore documents are capped at 1 MiB
export const MAX_KEYS = 1500;
export const MAX_KEY_BYTES = 1000; // Firestore document ids are capped at 1500 bytes
export const HUB_KEYS = new Set(['favorites', 'gameStats', 'gameHubTheme']);

// Keys that are never synced: our own bookkeeping, Firebase's auth cache, analytics cookies.
const DENY = [/^__ghsync:/, /^firebase[:-]/, /^_ga(_|$)/, /^_gid$/, /^_gat(_|$)/];

const encoder = new TextEncoder();

export function isSyncable(key) {
    return typeof key === 'string'
        && key.length > 0
        && encoder.encode(key).length <= MAX_KEY_BYTES
        && !DENY.some((re) => re.test(key));
}

function byteLength(str) {
    // Skip the encode for short strings: 3 bytes/char is the worst case for UTF-8 of UTF-16 text.
    return str.length * 3 <= MAX_VALUE_BYTES ? str.length * 3 : encoder.encode(str).length;
}

/** Firestore document id for a localStorage key (ids can't contain "/" and have other limits). */
export function keyToDocId(key) {
    let bin = '';
    for (const b of encoder.encode(key)) bin += String.fromCharCode(b);
    return 'k' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** cyrb53 string hash plus length. Only used to detect change, not for security. */
export function hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '.' + str.length.toString(36);
}

/**
 * Read every syncable key out of a Storage-like object.
 * `skipped` holds keys that exist but can't be synced (too big, or over the key cap); they must be
 * left alone rather than treated as deleted.
 */
export function takeSnapshot(storage) {
    const names = [];
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null) names.push(key);
    }
    names.sort();

    const entries = new Map();
    const skipped = new Set();
    for (const key of names) {
        if (!isSyncable(key)) continue;
        const value = storage.getItem(key);
        if (value === null) continue;
        // Lone surrogates aren't valid UTF-8, so Firestore would reject the whole batch.
        const malformed = typeof value.isWellFormed === 'function' && !value.isWellFormed();
        if (malformed || entries.size >= MAX_KEYS || byteLength(value) > MAX_VALUE_BYTES) {
            skipped.add(key);
            continue;
        }
        entries.set(key, value);
    }
    return { entries, skipped };
}

/** What to upload: keys whose value differs from the base, plus tombstones for keys removed locally. */
export function planPush({ entries, skipped }, base) {
    const writes = [];
    const nextBase = {};

    for (const [key, value] of entries) {
        const h = hash(value);
        const known = base[key];
        if (known && !known.del && known.h === h) {
            nextBase[key] = known;
        } else {
            writes.push({ key, value, deleted: false });
            nextBase[key] = { h };
        }
    }

    for (const [key, known] of Object.entries(base)) {
        if (entries.has(key)) continue;
        if (skipped.has(key) || known.del) {
            nextBase[key] = known;
        } else {
            writes.push({ key, value: '', deleted: true });
            nextBase[key] = { del: true };
        }
    }

    return { writes, nextBase };
}

/** Split writes into batches that stay under Firestore's per-commit limits. */
export function chunkWrites(writes, maxCount = 200, maxBytes = 3_000_000) {
    const chunks = [];
    let current = [];
    let bytes = 0;
    for (const write of writes) {
        const size = write.value.length * 3 + write.key.length * 3 + 100;
        if (current.length && (current.length >= maxCount || bytes + size > maxBytes)) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(write);
        bytes += size;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

/** Playtime stats: keep the larger figure for each game so neither device's minutes are lost. */
export function mergeStats(a, b) {
    try {
        const x = JSON.parse(a);
        const y = JSON.parse(b);
        if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return b;
        const out = { ...y };
        for (const [name, minutes] of Object.entries(x)) {
            out[name] = typeof minutes === 'number' && typeof out[name] === 'number'
                ? Math.max(minutes, out[name])
                : (out[name] ?? minutes);
        }
        if ('totalMinutes' in out) {
            // totalMinutes is the sum of the per-game figures, so recompute it from the merged ones.
            out.totalMinutes = Object.entries(out)
                .filter(([name, minutes]) => name !== 'totalMinutes' && typeof minutes === 'number')
                .reduce((sum, [, minutes]) => sum + minutes, 0);
        }
        return JSON.stringify(out);
    } catch {
        return b;
    }
}

/** Favorites are a comma-separated list; union keeps favorites from both devices. */
export function mergeFavorites(a, b) {
    const seen = new Set();
    for (const name of [...a.split(','), ...b.split(',')]) {
        if (name) seen.add(name);
    }
    return [...seen].join(',');
}

/**
 * Decide how to fold the cloud's changes into this device.
 *
 *  - remote:  [{ key, value, deleted }] docs that are new since the last pull (all docs when `fresh`)
 *  - entries: this device's current syncable keys
 *  - base:    hashes recorded at the last sync
 *  - fresh:   true on a device's first sync for this account (there is no base to compare with)
 *  - prefer:  'cloud' | 'device', how to settle first-sync conflicts the user was asked about
 *
 * Returns { applies, nextBase, conflicts, needsChoice }. `applies` entries with value === null mean
 * "remove this key". Keys where this device wins, or that were merged, are left out of nextBase on
 * purpose so the push that follows uploads this device's version.
 */
export function planPull({ remote, entries, base, fresh, prefer }) {
    const applies = [];
    const nextBase = { ...base };
    const conflicts = [];

    for (const doc of remote) {
        const { key } = doc;
        if (!isSyncable(key)) continue;

        const has = entries.has(key);
        const local = has ? entries.get(key) : undefined;
        const known = base[key];
        const localChanged = fresh || !(known && !known.del && has && known.h === hash(local));

        if (doc.deleted) {
            if (!has) {
                nextBase[key] = { del: true };
            } else if (!localChanged) {
                applies.push({ key, value: null });
                nextBase[key] = { del: true };
            }
            // Present and changed here (or first sync): this device's copy wins and gets re-uploaded.
            continue;
        }

        const remoteHash = hash(doc.value);
        if (!has) {
            // Known at the last sync but gone now means it was deleted here, and the cloud copy is just
            // the echo of our own earlier upload: leave it so the push sends a tombstone. If the cloud
            // copy has changed since, keep the data rather than the deletion.
            if (!fresh && known && !known.del && known.h === remoteHash) continue;
            applies.push({ key, value: doc.value });
            nextBase[key] = { h: remoteHash };
            continue;
        }
        if (hash(local) === remoteHash) {
            nextBase[key] = { h: remoteHash };
            continue;
        }

        // The two sides differ.
        if (key === 'gameStats' && (fresh || localChanged)) {
            applies.push({ key, value: mergeStats(local, doc.value) });
        } else if (key === 'favorites' && fresh) {
            applies.push({ key, value: mergeFavorites(local, doc.value) });
        } else if (fresh && HUB_KEYS.has(key)) {
            applies.push({ key, value: doc.value }); // e.g. theme: take the cloud's without asking
            nextBase[key] = { h: remoteHash };
        } else if (!localChanged) {
            applies.push({ key, value: doc.value });
            nextBase[key] = { h: remoteHash };
        } else if (fresh) {
            conflicts.push(key);
            if (prefer === 'cloud') {
                applies.push({ key, value: doc.value });
                nextBase[key] = { h: remoteHash };
            }
            // prefer === 'device' (or undecided): leave it so the push uploads this device's value.
        }
        // Otherwise both sides changed since the last sync: this device wins and is uploaded.
    }

    return { applies, nextBase, conflicts, needsChoice: fresh && prefer === undefined && conflicts.length > 0 };
}
