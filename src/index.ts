import express from "express";
import redis from "redis";
import { promisify } from "util";
import { LeaderboardResponse, Country } from "./types";
import countryList from "./countries.json";
import playerList from "./players.json";

const allPlayers: LeaderboardResponse["players"] = playerList;
const allCountries = Object.entries(countryList).reduce(
  (prev, [id, country]) => {
    prev[id] = { ...country, id };
    return prev;
  },
  {} as { [id: string]: Country }
);

const r = redis.createClient({ db: 1 });
r.on("error", err => console.log(`error: ${err}`));

// keep the connection up
setInterval(function() {
  console.log("redisClient => Sending Ping...");
  r.ping();
}, 60000); // 60 seconds

const getAsync = promisify(r.get).bind(r);

const app = express();
const port = 8080 || process.env.PORT;

app.get("/", (_, res) => {
  res.send("sup");
});

app.get("/stats", async (req, res) => {
  const { query } = req;
  const lastUpdate = parseInt((await getAsync("lastupdate")) || "0", 10);
  if (query.from && typeof query.from === "number") {
    if (parseInt(query.from, 10) >= lastUpdate) {
      res.statusMessage = "Not modified";
      res.status(304).end();
      return;
    }
  }
  const multi = r
    .multi()
    .zrevrangebyscore(
      "leaders:co2",
      "+inf",
      "-inf",
      "withscores",
      "limit",
      0,
      10
    )
    .zrevrangebyscore(
      "leaders:trees",
      "+inf",
      "-inf",
      "withscores",
      "limit",
      0,
      10
    );

  Object.keys(allCountries).forEach(id => {
    multi.zrangebyscore(
      `history:co2:${id}`,
      query.from || 0,
      "+inf",
      "withscores"
    );
    multi.zrangebyscore(
      `history:trees:${id}`,
      query.from || 0,
      "+inf",
      "withscores"
    );
  });

  multi.exec((_, replies) => {
    res.send(parseRedisResponse(replies));
  });
});

const parseZrange = (response: any[]) =>
  response.reduce(
    (prev, current, i) => {
      if (i % 2) {
        const a = prev[prev.length - 1];
        a.push(current);
      } else prev.push([current]);
      return prev;
    },
    [] as Array<[string, number]>
  );

const parseRedisResponse = (replies: any[]): LeaderboardResponse => {
  const [emissions, trees] = [0, 1].map(i => parseZrange(replies[i]));

  const players: LeaderboardResponse["players"] = {};

  emissions.forEach(([address]: [string]) => {
    players[address] = allPlayers[address];
  });
  trees.forEach(([address]: [string]) => {
    if (!(address in players)) {
      players[address] = allPlayers[address];
    }
  });

  const emissionHistory: LeaderboardResponse["emissionHistory"] = {};
  const treeHistory: LeaderboardResponse["treeHistory"] = {};

  Object.keys(allCountries).forEach((id, i) => {
    emissionHistory[id] = parseZrange(replies[2 + i * 2]);
    treeHistory[id] = parseZrange(replies[3 + i * 2]);
  });

  return {
    players,
    emissions,
    trees,
    emissionHistory,
    treeHistory
  };
};

app.listen(port, () => {
  // tslint:disable-next-line:no-console
  console.log(`server started at http://localhost:${port}`);
});
