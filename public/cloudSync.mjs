// Keeps this browser's localStorage (hub settings + every game's saves) in step with the signed-in
// user's Firestore data at users/{uid}/saves. Only runs while someone is signed in with Google.
// The merge rules live in syncCore.mjs; this file does the Firestore I/O, scheduling and bookkeeping.
import { db, firestore } from "./firebase.mjs";
import { takeSnapshot, planPush, planPull, chunkWrites, keyToDocId, isSyncable } from "./syncCore.mjs";

// Bookkeeping that lives in localStorage next to the saves (never synced itself; see syncCore DENY).
const K_OWNER = '__ghsync:owner';   // uid this device was last synced with
const K_BASE = '__ghsync:base';     // { key: { h: hash } | { del: true } } as of the last sync
const K_CURSOR = '__ghsync:cursor'; // newest server timestamp (ms) already pulled

const PUSH_DELAY_MS = 15_000; // after a change, wait this long before uploading (batches rapid saves)
const POLL_MS = 60_000;       // while the hub is visible, look for changes from other devices
const PAUSED = Symbol('paused');

let session = null;
let status = { state: 'off' };
const statusListeners = new Set();

function setStatus(next) {
    status = next;
    for (const cb of statusListeners) {
        try { cb(status); } catch (err) { console.error(err); }
    }
}

/** Subscribe to { state: 'off'|'syncing'|'synced'|'paused'|'error', at?, message? }. Returns an unsubscribe fn. */
export function onSyncStatus(cb) {
    statusListeners.add(cb);
    cb(status);
    return () => statusListeners.delete(cb);
}

function readJSON(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
        return fallback;
    }
}

function persist(s) {
    try {
        localStorage.setItem(K_OWNER, s.uid);
        localStorage.setItem(K_BASE, JSON.stringify(s.base));
        localStorage.setItem(K_CURSOR, String(s.cursor));
    } catch (err) {
        // Storage is full. Sync still works this session; the next one may re-compare more keys.
        console.warn('Could not save sync bookkeeping:', err);
    }
}

/**
 * Begin syncing for `uid`. `askChoice(conflictKeys)` is called at most once, on a device's first sync
 * with an account, when the device and the cloud disagree; it resolves to 'cloud', 'device' or null.
 */
export function startSync(uid, { askChoice }) {
    if (session?.uid === uid) return;
    stopSync();

    const s = {
        uid, askChoice,
        base: {}, cursor: 0, fresh: true,
        timer: null, due: 0, poll: null,
        running: null, rerun: false,
        paused: false, fatal: false,
        cleanup: [],
    };
    if (localStorage.getItem(K_OWNER) === uid) {
        s.base = readJSON(K_BASE, {});
        s.cursor = Number(localStorage.getItem(K_CURSOR)) || 0;
        s.fresh = false;
    }
    session = s;

    const listen = (target, type, fn) => {
        target.addEventListener(type, fn);
        s.cleanup.push(() => target.removeEventListener(type, fn));
    };
    // Other tabs (the games) changing localStorage fire this in the hub tab. Changes made by the hub
    // itself don't, so those are caught by the poll and by the visibility/focus hooks below.
    listen(window, 'storage', (e) => {
        if (e.storageArea === localStorage && (e.key === null || isSyncable(e.key))) schedule(PUSH_DELAY_MS);
    });
    listen(document, 'visibilitychange', () => schedule(document.hidden ? 0 : 500));
    listen(window, 'focus', () => schedule(500));
    listen(window, 'pagehide', () => schedule(0));
    listen(window, 'online', () => schedule(1000));
    s.poll = setInterval(() => { if (!document.hidden) schedule(0); }, POLL_MS);

    schedule(0);
}

export function stopSync() {
    const s = session;
    if (!s) return;
    session = null;
    clearTimeout(s.timer);
    clearInterval(s.poll);
    s.cleanup.forEach((fn) => fn());
    setStatus({ state: 'off' });
}

/** Sync right now (also un-pauses). Resolves when the cycle finishes. */
export async function syncNow() {
    const s = session;
    if (!s) return;
    s.paused = false;
    s.fatal = false;
    if (s.running) await s.running;
    await cycle(s);
}

function schedule(delay) {
    const s = session;
    if (!s || s.fatal || s.paused) return;
    const due = Date.now() + delay;
    if (s.timer && s.due <= due) return; // an earlier run is already queued
    clearTimeout(s.timer);
    s.due = due;
    s.timer = setTimeout(() => {
        s.timer = null;
        s.due = 0;
        cycle(s);
    }, delay);
}

async function cycle(s) {
    if (session !== s) return;
    if (s.running) {
        s.rerun = true;
        return s.running;
    }
    s.running = (async () => {
        setStatus({ state: 'syncing' });
        try {
            await pull(s);
            if (session !== s) return;
            await push(s);
            if (session !== s) return;
            setStatus({ state: 'synced', at: Date.now() });
        } catch (err) {
            if (session !== s) return;
            if (err === PAUSED) {
                setStatus({ state: 'paused', message: 'Sync is paused until you pick which saves to keep.' });
            } else if (err?.code === 'permission-denied') {
                s.fatal = true; // retrying won't help until the rules are deployed
                setStatus({ state: 'error', message: "Cloud saves aren't switched on for this project yet." });
            } else {
                console.warn('Cloud sync failed:', err);
                setStatus({ state: 'error', message: "Couldn't reach your cloud saves. Will retry." });
            }
        }
    })();
    await s.running;
    s.running = null;
    if (s.rerun) {
        s.rerun = false;
        schedule(1000);
    }
}

async function pull(s) {
    const col = firestore.collection(db, 'users', s.uid, 'saves');
    const q = s.cursor
        ? firestore.query(col, firestore.where('st', '>=', firestore.Timestamp.fromMillis(s.cursor)))
        : col;
    const snap = await firestore.getDocs(q);
    if (session !== s) return;

    const remote = [];
    let cursor = s.cursor;
    snap.forEach((d) => {
        const data = d.data();
        if (typeof data.k !== 'string') return;
        remote.push({ key: data.k, value: typeof data.v === 'string' ? data.v : '', deleted: data.d === true });
        const ms = data.st?.toMillis?.();
        if (ms > cursor) cursor = ms;
    });

    const { entries } = takeSnapshot(localStorage);
    let plan = planPull({ remote, entries, base: s.base, fresh: s.fresh });
    if (plan.needsChoice) {
        const choice = await s.askChoice(plan.conflicts);
        if (session !== s) return;
        if (choice !== 'cloud' && choice !== 'device') {
            s.paused = true;
            throw PAUSED;
        }
        plan = planPull({ remote, entries, base: s.base, fresh: true, prefer: choice });
    }

    const applied = [];
    for (const { key, value } of plan.applies) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
            applied.push(key);
        } catch (err) {
            // Couldn't write (storage full): keep what we knew so the key isn't treated as in sync.
            console.warn(`Could not apply cloud save for "${key}":`, err);
            if (s.base[key]) plan.nextBase[key] = s.base[key];
            else delete plan.nextBase[key];
        }
    }

    s.base = plan.nextBase;
    s.cursor = cursor;
    s.fresh = false;
    persist(s);

    if (applied.length) {
        window.dispatchEvent(new CustomEvent('gamehub:sync-applied', { detail: { keys: applied } }));
    }
}

async function push(s) {
    const { writes, nextBase } = planPush(takeSnapshot(localStorage), s.base);
    try {
        for (const chunk of chunkWrites(writes)) {
            const batch = firestore.writeBatch(db);
            for (const w of chunk) {
                batch.set(firestore.doc(db, 'users', s.uid, 'saves', keyToDocId(w.key)), {
                    k: w.key,
                    v: w.value,
                    d: w.deleted,
                    st: firestore.serverTimestamp(),
                });
            }
            await batch.commit();
            for (const w of chunk) s.base[w.key] = nextBase[w.key]; // committed, so remember it
        }
        s.base = nextBase;
    } finally {
        persist(s);
    }
}
