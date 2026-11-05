const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const User = require('./models/user');
const Task = require('./models/task');
const app = express();

app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
    res.set('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
require('./routes')(app, express.Router());
app.use((req, res) => res.status(404).json({ message: 'Route not found.', data: {} }));
app.use((error, req, res, next) => {
    let status = 500;
    let message = 'The server could not complete your request.';
    if (error.status === 400 || error.status === 404) {
        status = error.status;
        message = error.type === 'entity.parse.failed' ? 'The request body must contain valid JSON.' : error.message;
    } else if (error.code === 11000) {
        status = 400;
        message = 'That email is already in use.';
    } else if (['ValidationError', 'CastError', 'StrictModeError'].includes(error.name) ||
        (req.method === 'GET' && ['MongoServerError', 'MongoInvalidArgumentError'].includes(error.name) && [2, 9, 168, 31253, 31254].includes(error.code))) {
        status = 400;
        message = 'The request contains an invalid field or query value.';
    }
    res.status(status).json({ message, data: {} });
});

if (require.main === module) {
    (async () => {
        if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in .env before starting.');
        await mongoose.connect(process.env.MONGODB_URI);
        await User.init();
        await Task.init();
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log('Server running on port ' + port));
    })().catch(() => {
        console.error('Startup failed. Check MONGODB_URI and your database network access.');
        process.exitCode = 1;
    });
}
module.exports = app;
