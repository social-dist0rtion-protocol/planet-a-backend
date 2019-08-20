import cors from "cors";
import express from "express";
import redis from "redis";
import { promisify } from "util";
import countryList from "./countries.json";
import playerList from "./players.json";
import { Country, LeaderboardResponse } from "./types";

const allPlayers: LeaderboardResponse["players"] = playerList;
const allCountries = Object.entries(countryList).reduce(
  (prev, [id, country]) => {
    prev[id] = { ...country, id };
    return prev;
  },
  {} as { [id: string]: Country }
);

const r = redis.createClient({ db: 1 });
r.on("error", (err) => console.log(`error: ${err}`));

// keep the connection up
setInterval(() => {
  console.log("redisClient => Sending Ping...");
  r.ping();
}, 60000); // 60 seconds

const getAsync = promisify(r.get).bind(r);

const app = express();
app.use(cors());
const port = 8080 || process.env.PORT;

app.get("/", (_, res) => {
  res.send("sup");
});

app.get("/stats", async (req, res) => {
  const { query } = req;
  const lastUpdate = parseInt((await getAsync("lastupdate")) || "0", 10);
  const from =
    (typeof query.from === "string" && parseInt(query.from, 10)) || 0;
  if (from >= lastUpdate) {
    res.statusMessage = "Not modified";
    res.status(304).end();
    console.log("304");
    return;
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

  Object.keys(allCountries).forEach((id) =>
    multi.zrangebyscore(`history:netco2:${id}`, from, "+inf", "withscores")
  );

  multi.exec((_, replies) => {
    res.send(parseRedisResponse(replies, lastUpdate));
  });
});

const parseZrange = (response: any[] = []) =>
  response.reduce(
    (prev, current, i) => {
      if (i % 2) {
        const a = prev[prev.length - 1];
        a.push(current);
      } else {
        prev.push([current]);
      }
      return prev;
    },
    [] as Array<[string, string]>
  );

const parseRedisResponse = (
  replies: any[],
  lastUpdate: number
): LeaderboardResponse => {
  const [emissions, trees] = [0, 1].map((i) => parseZrange(replies[i]));

  const players: LeaderboardResponse["players"] = {};

  emissions.forEach(([address]: [string]) => {
    players[address] = allPlayers[address];
  });
  trees.forEach(([address]: [string]) => {
    if (!(address in players)) {
      players[address] = allPlayers[address];
    }
  });

  const netCO2History: LeaderboardResponse["netCO2History"] = {};

  Object.keys(allCountries).forEach((id, i) => {
    netCO2History[id] = parseZrange(replies[2 + i]);
  });

  return {
    lastUpdate,
    players,
    emissions,
    trees,
    netCO2History
  };
};

app.listen(port, () => {
  // tslint:disable-next-line:no-console
  console.log(`server started at http://localhost:${port}`);
});
