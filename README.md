# Planet-A Backend

A simple node.js backend to update stats to, and to serve stats from redis to [Planet A Dashboard](https://github.com/social-dist0rtion-protocol/planet-a-dashboard).

## What's in here

1. An [Express](http://expressjs.com/) server configured in the [src/index.ts file](https://github.com/social-dist0rtion-protocol/planet-a-backend/blob/master/src/index.ts) which serves data from redis whenever the `from` query param sent by the client is older than the last update (or else, a `304 Not Modified` is served)
2. A [node app running as daemon](https://github.com/social-dist0rtion-protocol/planet-a-backend/blob/master/src/updater.ts) grabbing data from the Leap network every 10 seconds, updating redis

## What's not in here

The client itself, which is hosted [as a separate repo](https://github.com/social-dist0rtion-protocol/planet-a-dashboard) and is served [via github.io](https://planet-a.github.io/).

## Dependencies

You need to have a local [Redis](https://redis.io) server running on port `6379` (the default). The Express server and the updater script both use the database at index `1` (so to connect to it, use `redis-cli -n 1`).

## Node scripts

- `npm run build` builds both the server and the updater. It currently fails with an error due to type definitions in the Leap library, but it actually does build TS into JS. The output is generated in the `dist` folder.
- `npm run dev` or `yarn dev` launches the Express server locally
- `npm run dev-updater` or `yarn dev-updater` launches the daemon script
