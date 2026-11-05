const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../server');
const User = require('../models/user');
const Task = require('../models/task');
let db, server, base;

before(async () => {
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await User.init();
    await Task.init();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    if (db) await db.stop();
});
async function request(method, path, body, status = 200) {
    if (method === 'DELETE' && status === 200) status = 204;
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (status === 204) {
        assert.equal(response.status, 204);
        assert.equal(await response.text(), '');
        return;
    }
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    assert.equal(typeof result.message, 'string');
    assert.ok(Object.hasOwn(result, 'data'));
    return result.data;
}
async function consistent() {
    const users = await User.find().lean();
    const tasks = await Task.find().lean();
    for (const task of tasks) {
        const owner = users.find(user => String(user._id) === task.assignedUser);
        if (task.assignedUser) {
            assert.ok(owner);
            assert.equal(task.assignedUserName, owner.name);
            assert.equal(owner.pendingTasks.includes(String(task._id)), !task.completed);
        } else assert.equal(task.assignedUserName, 'unassigned');
    }
    for (const user of users) for (const id of user.pendingTasks) {
        const task = tasks.find(task => String(task._id) === id);
        assert.ok(task && !task.completed && task.assignedUser === String(user._id));
    }
}

test('CRUD, assignment moves, completion, replacement defaults, and deletion', async () => {
    const a = await request('POST', '/users', { name: 'Alice', email: 'alice@test' }, 201);
    const b = await request('POST', '/users', { name: 'Bob', email: 'bob@test' }, 201);
    let task = await request('POST', '/tasks', { name: 'Homework', deadline: '2026-12-01', assignedUser: a._id }, 201);
    assert.equal(task.assignedUserName, 'Alice');
    await consistent();
    await request('PUT', '/users/' + b._id, { name: 'Bobby', email: b.email, pendingTasks: [task._id] });
    await consistent();
    task = await request('PUT', '/tasks/' + task._id, { name: 'Done', deadline: 1800000000000, assignedUser: b._id, completed: true });
    await request('PUT', '/users/' + b._id, { name: 'Robert', email: b.email });
    assert.equal((await request('GET', '/tasks/' + task._id)).assignedUserName, 'Robert');
    await consistent();
    await request('PUT', '/tasks/' + task._id, { name: 'Again', deadline: '2026-12-02', assignedUser: a._id });
    await consistent();
    await request('PUT', '/users/' + a._id, { name: 'Alice', email: a.email });
    assert.equal((await request('GET', '/tasks/' + task._id)).assignedUser, '');
    const replaced = await request('PUT', '/tasks/' + task._id, { name: 'Reset', deadline: '2026-12-03' });
    assert.equal(replaced.dateCreated, task.dateCreated);
    assert.equal(replaced.description, '');
    await request('PUT', '/tasks/' + task._id, { name: 'Done again', deadline: '2026-12-03', assignedUser: b._id, completed: true });
    await request('DELETE', '/users/' + b._id);
    assert.equal((await request('GET', '/tasks/' + task._id)).assignedUserName, 'unassigned');
    await request('PUT', '/tasks/' + task._id, { name: 'Pending', deadline: '2026-12-03', assignedUser: a._id });
    await request('DELETE', '/tasks/' + task._id);
    await request('GET', '/tasks/' + task._id, undefined, 404);
    await consistent();
});

test('validation precedence and failed writes leave database unchanged', async () => {
    const user = await request('POST', '/users', { name: 'Validation', email: 'validate@test' }, 201);
    const done = await request('POST', '/tasks', { name: 'Done', deadline: '2026-12-01', completed: true }, 201);
    const missing = '000000000000000000000001';
    const beforeUsers = JSON.stringify(await User.find().lean());
    const beforeTasks = JSON.stringify(await Task.find().lean());
    await request('PUT', '/users/bad', {}, 404);
    await request('PUT', '/tasks/' + missing, {}, 404);
    await request('POST', '/users', { name: 'Duplicate', email: user.email, pendingTasks: [missing] }, 400);
    await request('PUT', '/users/' + user._id, { name: 'X', email: user.email, pendingTasks: [done._id, missing] }, 400);
    await request('PUT', '/users/' + user._id, { name: 'X', email: user.email, pendingTasks: [missing] }, 404);
    await request('POST', '/tasks', { name: 42, deadline: '2026-12-01' }, 400);
    await request('POST', '/tasks', { name: 'X', deadline: null }, 400);
    await request('POST', '/tasks', { name: 'X', deadline: '2026-12-01', completed: 'false' }, 400);
    await request('POST', '/tasks', { name: 'X', deadline: '2026-12-01', assignedUser: user._id, assignedUserName: 'Wrong' }, 400);
    await request('POST', '/tasks', { name: 'X', deadline: '2026-12-01', assignedUser: missing }, 404);
    assert.equal(JSON.stringify(await User.find().lean()), beforeUsers);
    assert.equal(JSON.stringify(await Task.find().lean()), beforeTasks);
});

test('query combinations, defaults, projection and empty results', async () => {
    await Task.insertMany(Array.from({ length: 105 }, (_, i) => ({ name: 'Query ' + String(i).padStart(3, '0'), deadline: new Date(), description: 'query-test' })));
    const where = encodeURIComponent(JSON.stringify({ description: 'query-test' }));
    assert.equal((await request('GET', '/tasks?where=' + where)).length, 100);
    const list = await request('GET', '/tasks?where=' + where + '&sort={"name":-1}&skip=2&limit=3&select={"name":1,"_id":0}');
    assert.deepEqual(list, [{ name: 'Query 102' }, { name: 'Query 101' }, { name: 'Query 100' }]);
    assert.equal(await request('GET', '/tasks?where=' + where + '&count=true&skip=100&limit=1'), 105);
    assert.deepEqual(await request('GET', '/users?where={"name":"Nobody"}'), []);
    for (const parameter of ['where', 'sort', 'select', 'skip', 'limit', 'count']) await request('GET', '/tasks?' + parameter + '={', undefined, 400);
    const task = (await request('GET', '/tasks?limit=1'))[0];
    const projected = await request('GET', '/tasks/' + task._id + '?select={"name":1,"_id":0}&where=bad&count=bad');
    assert.deepEqual(projected, { name: task.name });
    await request('GET', '/tasks?limit=-1', undefined, 400);
});

test('concurrent task reassignment preserves references', async () => {
    const a = await request('POST', '/users', { name: 'Concurrent A', email: 'ca@test' }, 201);
    const b = await request('POST', '/users', { name: 'Concurrent B', email: 'cb@test' }, 201);
    const task = await request('POST', '/tasks', { name: 'Race', deadline: '2026-12-01' }, 201);
    await Promise.all([a, b].map(user => request('PUT', '/tasks/' + task._id, { name: 'Race', deadline: '2026-12-01', assignedUser: user._id })));
    await consistent();
});
