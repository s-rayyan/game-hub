// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isSyncable, keyToDocId, hash, takeSnapshot, planPush, planPull, chunkWrites,
    mergeStats, mergeFavorites, MAX_VALUE_BYTES, MAX_KEYS,
} from '../public/syncCore.mjs';

function makeStorage(obj = {}) {
    const m = new Map(Object.entries(obj));
    return {
        get length() { return m.size; },
        key: (i) => [...m.keys()][i] ?? null,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        dump: () => Object.fromEntries(m),
    };
}

// Mirrors the orchestration in cloudSync.mjs (pull, then push) against an in-memory "cloud".
function makeCloud() { return { docs: new Map(), clock: 0 }; }
function makeDevice(obj = {}) { return { ls: makeStorage(obj), base: {}, cursor: 0, fresh: true }; }
function sync(dev, cloud, prefer) {
    const remote = [...cloud.docs.values()].filter((d) => d.st >= dev.cursor);
    const { entries } = takeSnapshot(dev.ls);
    let plan = planPull({ remote, entries, base: dev.base, fresh: dev.fresh });
    if (plan.needsChoice) {
        assert.ok(prefer, 'sync() hit a conflict but the test gave no preference');
        plan = planPull({ remote, entries, base: dev.base, fresh: true, prefer });
    }
    for (const { key, value } of plan.applies) {
        if (value === null) dev.ls.removeItem(key);
        else dev.ls.setItem(key, value);
    }
    dev.base = plan.nextBase;
    dev.cursor = Math.max(dev.cursor, ...remote.map((d) => d.st));
    dev.fresh = false;

    const { writes, nextBase } = planPush(takeSnapshot(dev.ls), dev.base);
    for (const w of writes) {
        cloud.docs.set(keyToDocId(w.key), { key: w.key, value: w.value, deleted: w.deleted, st: ++cloud.clock });
    }
    dev.base = nextBase;
    return { plan, writes };
}

test('isSyncable skips bookkeeping, firebase and analytics keys', () => {
    assert.equal(isSyncable('favorites'), true);
    assert.equal(isSyncable('save slot/1'), true);
    assert.equal(isSyncable('__ghsync:base'), false);
    assert.equal(isSyncable('firebase:authUser:abc:[DEFAULT]'), false);
    assert.equal(isSyncable('firebase-heartbeat-store'), false);
    assert.equal(isSyncable('_ga'), false);
    assert.equal(isSyncable('_ga_ABC123'), false);
    assert.equal(isSyncable('_game_state'), true);
    assert.equal(isSyncable(''), false);
    assert.equal(isSyncable('x'.repeat(1001)), false);
});

test('keyToDocId is a safe, stable, collision-free id', () => {
    const keys = ['a', 'a/b', 'a b', 'é', '🎮', '..', '.', '__x__', 'k'];
    const ids = keys.map(keyToDocId);
    assert.equal(new Set(ids).size, keys.length);
    for (const id of ids) {
        assert.match(id, /^k[A-Za-z0-9_-]*$/);
        assert.ok(!/^__.*__$/.test(id));
    }
    assert.equal(keyToDocId('a/b'), keyToDocId('a/b'));
});

test('hash distinguishes values and is stable', () => {
    assert.equal(hash('abc'), hash('abc'));
    assert.notEqual(hash('abc'), hash('abd'));
    assert.notEqual(hash(''), hash(' '));
});

test('takeSnapshot filters keys and records skipped ones', () => {
    const ls = makeStorage({
        score: '10',
        '__ghsync:base': '{}',
        'firebase:x': 'y',
        huge: 'a'.repeat(MAX_VALUE_BYTES + 1),
        bad: 'oops\ud800',
    });
    const { entries, skipped } = takeSnapshot(ls);
    assert.deepEqual([...entries.keys()], ['score']);
    assert.deepEqual([...skipped].sort(), ['bad', 'huge']);
});

test('takeSnapshot caps the number of keys', () => {
    const obj = {};
    for (let i = 0; i < MAX_KEYS + 5; i++) obj['k' + String(i).padStart(5, '0')] = 'v';
    const { entries, skipped } = takeSnapshot(makeStorage(obj));
    assert.equal(entries.size, MAX_KEYS);
    assert.equal(skipped.size, 5);
});

test('planPush uploads new and changed keys once, and tombstones removals once', () => {
    const snap = (o, skipped = []) => ({ entries: new Map(Object.entries(o)), skipped: new Set(skipped) });

    let { writes, nextBase } = planPush(snap({ a: '1', b: '2' }), {});
    assert.deepEqual(writes.map((w) => w.key).sort(), ['a', 'b']);

    ({ writes, nextBase } = planPush(snap({ a: '1', b: '2' }), nextBase));
    assert.equal(writes.length, 0);

    ({ writes, nextBase } = planPush(snap({ a: '1', b: '3' }), nextBase));
    assert.deepEqual(writes, [{ key: 'b', value: '3', deleted: false }]);

    ({ writes, nextBase } = planPush(snap({ b: '3' }), nextBase));
    assert.deepEqual(writes, [{ key: 'a', value: '', deleted: true }]);

    ({ writes, nextBase } = planPush(snap({ b: '3' }), nextBase));
    assert.equal(writes.length, 0, 'tombstone is only written once');

    ({ writes } = planPush(snap({ a: 'back', b: '3' }), nextBase));
    assert.deepEqual(writes, [{ key: 'a', value: 'back', deleted: false }], 'a deleted key can return');
});

test('planPush leaves skipped keys alone instead of deleting them', () => {
    const base = { big: { h: 'x' } };
    const { writes, nextBase } = planPush({ entries: new Map(), skipped: new Set(['big']) }, base);
    assert.equal(writes.length, 0);
    assert.deepEqual(nextBase, base);
});

test('chunkWrites respects count and size limits', () => {
    const w = (i, size = 10) => ({ key: 'k' + i, value: 'x'.repeat(size), deleted: false });
    assert.deepEqual(chunkWrites([]).length, 0);
    assert.equal(chunkWrites(Array.from({ length: 5 }, (_, i) => w(i)), 2).length, 3);
    // Sizes are estimated at 3 bytes/char, so these are ~1.2 MB each: two fit in 3 MB, three don't.
    const big = chunkWrites([w(1, 400_000), w(2, 400_000), w(3, 400_000)], 200, 3_000_000);
    assert.equal(big.length, 2);
    assert.equal(big.flat().length, 3);
});

test('mergeStats keeps the larger figure per game and recomputes the total', () => {
    const merged = JSON.parse(mergeStats(
        JSON.stringify({ Chess: 30, Pong: 5, totalMinutes: 35 }),
        JSON.stringify({ Chess: 10, Snake: 20, totalMinutes: 30 }),
    ));
    assert.deepEqual(merged, { Chess: 30, Snake: 20, Pong: 5, totalMinutes: 55 });
    assert.equal(mergeStats('not json', '{"a":1}'), '{"a":1}');
});

test('mergeFavorites unions both lists without blanks or duplicates', () => {
    assert.equal(mergeFavorites(',Chess,Pong', 'Pong,Snake'), 'Chess,Pong,Snake');
});

test('first sync on an empty account uploads everything', () => {
    const cloud = makeCloud();
    const laptop = makeDevice({ score: '10', favorites: 'Chess' });
    const { writes } = sync(laptop, cloud);
    assert.deepEqual(writes.map((w) => w.key).sort(), ['favorites', 'score']);
    assert.equal(cloud.docs.size, 2);
});

test('a new device receives the account\'s saves', () => {
    const cloud = makeCloud();
    sync(makeDevice({ score: '10', level: '4' }), cloud);
    const phone = makeDevice();
    sync(phone, cloud);
    assert.deepEqual(phone.ls.dump(), { score: '10', level: '4' });
});

test('first-sync conflicts need a choice, and each choice is honored', () => {
    const cloud = makeCloud();
    sync(makeDevice({ score: '100', other: 'a' }), cloud);

    const keepCloud = makeDevice({ score: '5', onlyHere: 'z' });
    const r = sync(keepCloud, cloud, 'cloud');
    assert.deepEqual(r.plan.conflicts, ['score']);
    assert.equal(keepCloud.ls.getItem('score'), '100');
    assert.equal(keepCloud.ls.getItem('other'), 'a');
    assert.equal(cloud.docs.get(keyToDocId('onlyHere')).value, 'z', 'device-only keys are uploaded');

    const keepDevice = makeDevice({ score: '5' });
    sync(keepDevice, cloud, 'device');
    assert.equal(keepDevice.ls.getItem('score'), '5');
    assert.equal(cloud.docs.get(keyToDocId('score')).value, '5');
});

test('no conflict prompt when the only differences are hub settings', () => {
    const cloud = makeCloud();
    sync(makeDevice({ gameHubTheme: 'glass', favorites: 'Chess', gameStats: '{"Chess":30,"totalMinutes":30}' }), cloud);
    const phone = makeDevice({ gameHubTheme: 'scifi', favorites: 'Pong', gameStats: '{"Pong":5,"totalMinutes":5}' });
    const { plan } = sync(phone, cloud); // no preference given: would throw if a choice were needed
    assert.equal(plan.needsChoice, false);
    assert.equal(phone.ls.getItem('gameHubTheme'), 'glass');
    assert.equal(phone.ls.getItem('favorites'), 'Pong,Chess');
    assert.deepEqual(JSON.parse(phone.ls.getItem('gameStats')), { Chess: 30, Pong: 5, totalMinutes: 35 });
    assert.equal(cloud.docs.get(keyToDocId('favorites')).value, 'Pong,Chess', 'merged value is uploaded');
});

test('changes flow both ways between two signed-in devices', () => {
    const cloud = makeCloud();
    const laptop = makeDevice({ score: '1' });
    const phone = makeDevice();
    sync(laptop, cloud);
    sync(phone, cloud);

    laptop.ls.setItem('score', '2');
    sync(laptop, cloud);
    sync(phone, cloud);
    assert.equal(phone.ls.getItem('score'), '2');

    phone.ls.setItem('level', '9');
    phone.ls.setItem('score', '3');
    sync(phone, cloud);
    sync(laptop, cloud);
    assert.equal(laptop.ls.getItem('score'), '3');
    assert.equal(laptop.ls.getItem('level'), '9');
});

test('deleting a key on one device removes it on the other', () => {
    const cloud = makeCloud();
    const laptop = makeDevice({ save: 'x', keep: 'y' });
    const phone = makeDevice();
    sync(laptop, cloud);
    sync(phone, cloud);

    laptop.ls.removeItem('save');
    sync(laptop, cloud);
    sync(phone, cloud);
    assert.deepEqual(phone.ls.dump(), { keep: 'y' });
});

test('a key deleted here but edited elsewhere meanwhile is kept, not lost', () => {
    const cloud = makeCloud();
    const laptop = makeDevice({ save: 'old' });
    const phone = makeDevice();
    sync(laptop, cloud);
    sync(phone, cloud);

    laptop.ls.removeItem('save'); // not synced yet
    phone.ls.setItem('save', 'new');
    sync(phone, cloud);
    sync(laptop, cloud);
    sync(phone, cloud);
    assert.equal(laptop.ls.getItem('save'), 'new');
    assert.equal(phone.ls.getItem('save'), 'new');
});

test('a device\'s own uploads echo back without causing changes', () => {
    const cloud = makeCloud();
    const laptop = makeDevice({ score: '1' });
    sync(laptop, cloud);
    const again = sync(laptop, cloud);
    assert.equal(again.writes.length, 0);
    assert.equal(again.plan.applies.length, 0);
});

test('when both devices change the same key, the one that syncs last wins and nothing else is lost', () => {
    const cloud = makeCloud();
    const laptop = makeDevice({ score: '1', a: '1' });
    const phone = makeDevice();
    sync(laptop, cloud);
    sync(phone, cloud);

    laptop.ls.setItem('score', 'laptop');
    laptop.ls.setItem('a', 'laptop-a');
    phone.ls.setItem('score', 'phone');
    sync(laptop, cloud);
    sync(phone, cloud); // phone's score wins locally; laptop's other change still arrives
    sync(laptop, cloud);

    assert.equal(phone.ls.getItem('a'), 'laptop-a');
    assert.equal(phone.ls.getItem('score'), 'phone');
    assert.equal(laptop.ls.getItem('score'), 'phone');
});

test('a key the device cannot sync is never tombstoned', () => {
    const cloud = makeCloud();
    const laptop = makeDevice({ save: 'small' });
    sync(laptop, cloud);
    laptop.ls.setItem('save', 'a'.repeat(MAX_VALUE_BYTES + 1)); // grew past the limit
    sync(laptop, cloud);
    assert.equal(cloud.docs.get(keyToDocId('save')).deleted, false);
    assert.equal(cloud.docs.get(keyToDocId('save')).value, 'small');
});
