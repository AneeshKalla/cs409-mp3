# Running the API

Use Node 24 (`.nvmrc` and `package.json` specify it). Run commands from this repository directory.

1. Run `npm install`.
2. Set `MONGODB_URI` in `.env` to your Atlas connection string, including a database name such as `mp3`. The local `.env` was created from `.env.example` and is ignored by Git.
3. Run `npm start`. The default port is 3000.
4. Run `npm test` for integration tests. Tests start an isolated temporary MongoDB replica set and do not use your Atlas database. The first run may download MongoDB.

# Atlas and Render

Create an Atlas cluster and a database user with read/write access to the application database. For this assignment, add the required network access entry `0.0.0.0/0`. Copy the application's driver connection string into `.env`, replacing the username/password placeholders and adding the database name. URL-encode special characters in the password.

Create your own public GitHub repository from the course template and push your implementation there. In Render, create a Node web service connected to that repository. Use `npm ci` as the build command and `npm start` as the start command. Set `MONGODB_URI` as a Render environment variable; do not upload `.env`. Node 24 is specified in `package.json`. If deploying a parent repository containing this folder, set the root directory to `mp3`; otherwise leave it blank.

Check `/api/users` on the deployed service. Then set `API_URL` in `submit.js` to the Render base URL and run `npm run submit`. The autograder has not been run yet; it requires a deployed API.

# Why pendingTasks exists

A task here is a todo item, such as "finish homework". It is unrelated to a running HTTP request or a backend thread. A user's `pendingTasks` contains IDs of unfinished todo items assigned to them. The task also stores its owner in `assignedUser`, so the assignment is stored in two places. Both representations must agree.

For example, replacing Alice's list `[A, B]` with `[B, C]` unassigns A, keeps B, and assigns C to Alice. If Bob previously owned C, C must also be removed from Bob's list. Finishing B removes it from Alice's pending list but preserves Alice as its owner. This is why updates compare the previous state to the requested state.

Multiple requests can invoke the same route handler while earlier requests await database operations. A function isn't restricted to one active invocation. Transactions ensure related database changes commit together or roll back together. Conflicting writes can be retried by the transaction helper.

# Sources and assignment disclosure

- Provided assignment and starter repository.
- OpenAI Codex conversation: implementation and testing assistance. The assignment requires submitting the chatlogs and completing the LLM survey.
- Mongoose transaction documentation: https://mongoosejs.com/docs/transactions.html

The route code keeps query processing and reference updates inline. Shared route registration avoids duplicating the same GET/DELETE/response logic for users and tasks.
