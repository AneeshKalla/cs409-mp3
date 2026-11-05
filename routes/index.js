const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

// These small helpers are shared by both resources.
function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

function validId(id) {
    return typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
}

module.exports = function (app, router) {
    router.get('/', (req, res) => res.json({ message: 'Task API is running.', data: {} }));

    for (const [resource, Model] of [['users', User], ['tasks', Task]]) {
        router.get('/' + resource, async (req, res) => {
            const options = {};
            for (const key of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
                if (req.query[key] !== undefined) {
                    try {
                        if (typeof req.query[key] !== 'string') throw new Error();
                        options[key] = JSON.parse(req.query[key]);
                    } catch {
                        fail(400, key + ' must contain valid JSON.');
                    }
                }
            }
            for (const key of ['where', 'sort', 'select']) {
                if (options[key] !== undefined && (!options[key] || typeof options[key] !== 'object' || Array.isArray(options[key]))) {
                    fail(400, key + ' must be an object.');
                }
            }
            for (const key of ['skip', 'limit']) {
                if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] < 0)) {
                    fail(400, key + ' must be a nonnegative integer.');
                }
            }
            if (options.count !== undefined && typeof options.count !== 'boolean') fail(400, 'count must be a boolean.');
            let query;
            if (options.count) {
                query = Model.countDocuments(options.where || {});
            } else {
                query = Model.find(options.where || {}).sort(options.sort || {}).select(options.select || {})
                    .skip(options.skip || 0).limit(options.limit ?? (resource === 'tasks' ? 100 : 0));
            }
            res.json({ message: 'OK', data: await query });
        });

        router.get('/' + resource + '/:id', async (req, res) => {
            if (!validId(req.params.id)) fail(404, 'Resource not found.');
            // Look up existence before projecting: an excluded _id is still a valid result.
            let query = Model.findById(req.params.id);
            if (req.query.select !== undefined) {
                let select;
                try {
                    if (typeof req.query.select !== 'string') throw new Error();
                    select = JSON.parse(req.query.select);
                } catch {
                    fail(400, 'select must contain valid JSON.');
                }
                if (!select || typeof select !== 'object' || Array.isArray(select)) fail(400, 'select must be an object.');
                query = query.select(select);
            }
            const item = await query;
            if (!item) fail(404, 'Resource not found.');
            res.json({ message: 'OK', data: item });
        });

        // POST and PUT share replacement validation and reference maintenance.
        router.route('/' + resource).post(save);
        router.route('/' + resource + '/:id').put(save);
        async function save(req, res) {
            const replacing = req.method === 'PUT';
            let result;
            await mongoose.connection.transaction(async session => {
                let item;
                if (replacing) {
                    if (!validId(req.params.id)) fail(404, 'Resource not found.');
                    item = await Model.findById(req.params.id).session(session);
                    if (!item) fail(404, 'Resource not found.');
                } else {
                    item = new Model();
                }
                const body = req.body;
                if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Provide a JSON object.');
                if (typeof body.name !== 'string' || !body.name.trim()) fail(400, 'A nonempty name is required.');

                if (resource === 'users') {
                    if (typeof body.email !== 'string' || !body.email.trim()) fail(400, 'A nonempty email is required.');
                    const pending = body.pendingTasks ?? [];
                    if (body.pendingTasks === null || !Array.isArray(pending) || !pending.every(validId)) {
                        fail(400, 'pendingTasks must be an array of valid task IDs.');
                    }
                    const ids = [...new Set(pending.map(id => id.toLowerCase()))];
                    const duplicate = await User.findOne({ email: body.email, _id: { $ne: item._id } }).session(session);
                    if (duplicate) fail(400, 'That email is already in use.');
                    const tasks = await Task.find({ _id: { $in: ids } }).session(session);
                    if (tasks.some(task => task.completed)) fail(400, 'Completed tasks cannot be pending.');
                    if (tasks.length !== ids.length) fail(404, 'One or more referenced tasks do not exist.');

                    const userId = String(item._id);
                    const removed = item.pendingTasks.filter(id => !ids.includes(id));
                    await Task.updateMany({ _id: { $in: removed }, assignedUser: userId },
                        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
                    await User.updateMany({ _id: { $ne: item._id }, pendingTasks: { $in: ids } },
                        { $pull: { pendingTasks: { $in: ids } } }, { session });
                    await Task.updateMany({ _id: { $in: ids } },
                        { $set: { assignedUser: userId, assignedUserName: body.name } }, { session });
                    // Completed tasks stay assigned and must also reflect a renamed user.
                    await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: body.name } }, { session });
                    item.set({ name: body.name, email: body.email, pendingTasks: ids });
                } else {
                    if (!['string', 'number'].includes(typeof body.deadline) || body.deadline === '' || !Number.isFinite(new Date(body.deadline).getTime())) {
                        fail(400, 'A valid deadline is required.');
                    }
                    for (const key of ['description', 'assignedUser', 'assignedUserName']) {
                        if (body[key] !== undefined && typeof body[key] !== 'string') fail(400, key + ' must be a string.');
                    }
                    if (body.completed !== undefined && typeof body.completed !== 'boolean') fail(400, 'completed must be a boolean.');
                    const assignedUser = (body.assignedUser ?? '').toLowerCase();
                    const completed = body.completed ?? false;
                    if (assignedUser && !validId(assignedUser)) fail(400, 'assignedUser must be a valid user ID.');
                    if (!assignedUser && body.assignedUserName !== undefined && body.assignedUserName !== 'unassigned') {
                        fail(400, 'An unassigned task must use the name unassigned.');
                    }
                    let user;
                    if (assignedUser) {
                        user = await User.findById(assignedUser).session(session);
                        if (!user) fail(404, 'The assigned user does not exist.');
                        if (body.assignedUserName !== undefined && body.assignedUserName !== user.name) {
                            fail(400, 'assignedUserName must match the assigned user.');
                        }
                    }
                    const taskId = String(item._id);
                    await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } }, { session });
                    if (user) {
                        // Saving the user also coordinates concurrent assignment/rename/delete requests.
                        if (!completed && !user.pendingTasks.includes(taskId)) user.pendingTasks.push(taskId);
                        if (completed) user.pendingTasks = user.pendingTasks.filter(id => id !== taskId);
                        user.markModified('pendingTasks');
                        await user.save({ session });
                    }
                    item.set({ name: body.name, description: body.description ?? '', deadline: new Date(body.deadline),
                        completed, assignedUser, assignedUserName: user ? user.name : 'unassigned' });
                }
                await item.save({ session });
                result = item.toObject();
            });
            res.status(replacing ? 200 : 201).json({ message: replacing ? 'Resource updated.' : 'Resource created.', data: result });
        }

        router.delete('/' + resource + '/:id', async (req, res) => {
            if (!validId(req.params.id)) fail(404, 'Resource not found.');
            await mongoose.connection.transaction(async session => {
                const item = await Model.findById(req.params.id).session(session);
                if (!item) fail(404, 'Resource not found.');
                if (resource === 'users') {
                    await Task.updateMany({ assignedUser: String(item._id) },
                        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
                } else {
                    await User.updateMany({ pendingTasks: String(item._id) },
                        { $pull: { pendingTasks: String(item._id) } }, { session });
                }
                await item.deleteOne({ session });
            });
            res.status(200).json({ message: 'Resource deleted.', data: {} });
        });
    }
    app.use('/api', router);
};
