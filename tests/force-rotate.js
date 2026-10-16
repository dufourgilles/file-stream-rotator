const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStream } = require('../lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-'));
let n = 0;

function create(extra) {
    const dir = path.join(tmp, 'case' + (n++));
    fs.mkdirSync(dir);
    return getStream(Object.assign({
        filename: path.join(dir, 'log'),
        extension: '.log',
        size: '1g',
        audit_file: path.join(dir, 'audit.json'),
        buffer_size: 100000,
    }, extra));
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.length);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const range = (a, b) => Array.from({ length: b - a }, (_, i) => 'line ' + (a + i));

async function testForceRotate() {
    const s = create();
    for (let i = 0; i < 1000; i++) s.write('line ' + i + '\n');
    const old = await s.forceRotate();
    for (let i = 1000; i < 1010; i++) s.write('line ' + i + '\n');
    await s.drain();
    assert.ok(old, 'old path returned');
    assert.deepStrictEqual(lines(old), range(0, 1000));
    const cur = s.test().rotator.getNewFilename();
    assert.notStrictEqual(cur, old);
    assert.deepStrictEqual(lines(cur), range(1000, 1010));
    assert.strictEqual(s.drops, 0);
}

async function testRotateCallback() {
    let seen, done = false;
    const s = create({
        rotate: async (file) => {
            await sleep(100);
            seen = lines(file);
            fs.copyFileSync(file, file + '.copy');
            done = true;
        },
    });
    for (let i = 0; i < 500; i++) s.write('line ' + i + '\n');
    const old = await s.forceRotate();
    assert.ok(done, 'callback finished before forceRotate resolved');
    assert.deepStrictEqual(seen, range(0, 500));
    assert.deepStrictEqual(lines(old + '.copy'), range(0, 500));
}

async function testRotateCallbackEndStream() {
    let seen;
    const s = create({ end_stream: true, rotate: async (file) => { seen = lines(file); } });
    for (let i = 0; i < 500; i++) s.write('line ' + i + '\n');
    await s.forceRotate();
    assert.deepStrictEqual(seen, range(0, 500));
}

async function testNotCountedAsDrop() {
    const s = create({ buffer_size: 5 });
    for (let i = 0; i < 5; i++) s.write('line ' + i + '\n');
    const p = s.forceRotate();
    s.write('x\n'); // buffer holds 5 lines + 1 rotation: line 6 is accepted only after the loop took them
    await p;
    await s.drain();
    assert.ok(s.drops <= 1);
}

async function testDrainContinuous() {
    const s = create();
    let i = 0, stop = false;
    const producer = setInterval(() => { for (let k = 0; k < 20 && !stop; k++) s.write('line ' + (i++) + '\n'); }, 1);
    await sleep(50);
    const before = i;
    await Promise.race([s.drain(), sleep(5000).then(() => { throw new Error('drain timeout'); })]);
    stop = true;
    clearInterval(producer);
    await s.drain();
    assert.ok(lines(s.test().rotator.getNewFilename()).length >= before);
}

async function testFlushOrder() {
    const s = create();
    let i = 0;
    const flushed = [];
    const producer = setInterval(() => { for (let k = 0; k < 10; k++) s.write('line ' + (i++) + '\n'); }, 1);
    for (let f = 0; f < 5; f++) {
        await sleep(20);
        await new Promise(r => s.flush(r));
        flushed.push(i);
    }
    clearInterval(producer);
    await s.drain();
    assert.deepStrictEqual(lines(s.test().rotator.getNewFilename()), range(0, i));
}

(async () => {
    for (const t of [testForceRotate, testRotateCallback, testRotateCallbackEndStream, testNotCountedAsDrop, testDrainContinuous, testFlushOrder]) {
        await t();
        console.log('ok', t.name);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
