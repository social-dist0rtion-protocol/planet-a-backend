import cors from "cors";
import express, { Response } from "express";
import redis from "redis";
import { promisify } from "util";
import countryList from "./countries.json";
import { Country, LeaderboardResponse } from "./types";

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
  if (from > 0 && from >= lastUpdate) {
    res.statusMessage = "Not modified";
    res.status(304).end();
    console.log("304");
    return;
  }
  const multi = r
    .multi()
    .zrevrangebyscore("leaders:co2", "+inf", "1", "withscores", "limit", 0, 10)
    .zrevrangebyscore(
      "leaders:trees",
      "+inf",
      "1",
      "withscores",
      "limit",
      0,
      10
    )
    .hgetall("countries:co2")
    .hgetall("countries:trees");

  Object.keys(allCountries).forEach(id =>
    multi.zrangebyscore(`history:netco2:${id}`, from, "+inf", "withscores")
  );

  multi.exec((_, replies) => {
    parseRedisResponse(res, replies, lastUpdate);
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
  res: Response,
  replies: any[],
  lastUpdate: number
) => {
  const [emissions, trees] = [0, 1].map(i => parseZrange(replies[i]));
  const [co2ByCountry, treesByCountry] = [replies[2], replies[3]];

  const netCO2History: LeaderboardResponse["netCO2History"] = {};

  Object.keys(allCountries).forEach((id, i) => {
    netCO2History[id] = parseZrange(replies[4 + i]);
  });

  const multi = r.multi();

  const fetchPlayers: { [address: string]: boolean } = {};

  emissions.forEach(([address]: [string]) => {
    fetchPlayers[address] = true;
  });
  trees.forEach(([address]: [string]) => {
    fetchPlayers[address] = true;
  });

  const addressesToFetch = Object.keys(fetchPlayers);

  addressesToFetch.forEach(address => multi.hgetall(`player:${address}`));

  multi.exec((_, playersFromRedis) =>
    res.send({
      lastUpdate,
      players: playersFromRedis
        .map(p => p || { name: "Mr. Mysterious", countryId: "unknown" })
        .reduce(
          (prev, current, i) => {
            prev[addressesToFetch[i]] = current;
            return prev;
          },
          {} as LeaderboardResponse["players"]
        ),
      emissions,
      trees,
      netCO2History,
      co2ByCountry,
      treesByCountry
    })
  );
};

app.listen(port, () => {
  // tslint:disable-next-line:no-console
  console.log(`server started at http://localhost:${port}`);
});
