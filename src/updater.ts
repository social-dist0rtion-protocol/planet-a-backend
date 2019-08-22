import { ExtendedWeb3, helpers, Unspent } from "leap-core";
import redis, { Callback } from "redis";
import Web3 from "web3";
import countryList from "./countries.json";
import ierc20 from "./ierc20.json";
import playerList from "./players.json";

const earthContractAddress = "0xc852eb0925f87ded366410c212a99da5ed9ef413";
// "0xd87ad15c109ed79c9cbf2058b6d188caaab6a063";
const totalGoeMillis = 9800000;
const goeAddress = "0x1f89Fb2199220a350287B162B9D0A330A2D2eFAD";

const playerNames: { [address: string]: { name: string } } = playerList;

const countries: {
  [id: string]: { name: string; color: string };
} = countryList;

const countryIds = Object.keys(countries);

const web3URL = "https://testnet-node.leapdao.org";
let web3: ExtendedWeb3;

const r = redis.createClient({ db: 1 });
r.on("error", err => console.log(`error: ${err}`));

type Passport = {
  address: string;
  country: string;
  co2: number;
  trees: number;
};

const parseTrees = (data: string) =>
  Web3.utils.hexToNumber(`0x${data.substring(50, 58)}`);

const parseCO2 = (data: string) =>
  Web3.utils.hexToNumber(`0x${data.substring(58, 66)}`);

const sumByCountry = (passports: Passport[], field: "co2" | "trees") =>
  passports.reduce(
    (prev, current) => {
      prev[current.country] = (prev[current.country] || 0) + current[field];
      return prev;
    },
    {} as { [countryId: string]: number }
  );

const getLastStateFromRedis = (callback: Callback<any[]>) => {
  const multi = r.multi();
  multi.get("laststate");
  countryIds.forEach(id =>
    multi.zrevrangebyscore(
      `history:netco2:${id}`,
      "+inf",
      "-inf",
      "withscores",
      "limit",
      0,
      1
    )
  );
  multi.exec(callback);
};

type Leaderboard = {
  updated: boolean;
  emissions: Array<[string, number]>;
  trees: Array<[string, number]>;
  emissionsByCountry: { [countryId: string]: number };
  treesByCountry: { [countryId: string]: number };
};

const getLeaderboard = () =>
  new Promise<Leaderboard>(resolve => {
    console.time("loading state from redis");

    getLastStateFromRedis(async (_, replies) => {
      const now = Math.floor(Date.now() / 1000).toString();

      const lastState: { [address: string]: Passport } = JSON.parse(
        replies[0] || "{}"
      );
      console.timeEnd("loading state from redis");

      const netCO2Balances = countryIds
        .map((id, i) => [id, replies[i + 1][0] || "0"])
        .reduce(
          (prev, [id, balance]) => {
            prev[id] = parseInt(balance.split(":")[1], 10);
            return prev;
          },
          {} as Leaderboard["emissionsByCountry"]
        );

      console.time("fetching balances for all countries");

      const promises: Array<{
        id: string;
        task: Promise<Unspent[]>;
        value?: Unspent[];
      }> = Object.keys(countryList).map(id => ({
        id,
        task: web3.getUnspent("", parseInt(id, 10)),
        value: []
      }));

      for (const promise of promises) {
        try {
          promise.value = await promise.task;
        } catch (error) {
          console.error(
            `error while fetching unspent of ${promise.id}: ${error}`
          );
          promise.value = [];
        }
      }

      const passports = promises
        .filter(p => p.value)
        .map(p =>
          p
            .value!.map(u => u.output)
            .filter(o => countries[o.color] && playerNames[o.value])
            .map(o => ({
              address: o.value,
              country: o.color.toString(),
              co2: parseCO2(o.data!),
              trees: parseTrees(o.data!)
            }))
        )
        .reduce(
          (prev, current) => {
            prev.push(...current);
            return prev;
          },
          [] as Passport[]
        );

      const emissionsByCountry = sumByCountry(passports, "co2");
      const treesByCountry = sumByCountry(passports, "trees");

      const newState = passports.reduce(
        (prev, current) => {
          prev[current.address] = current;
          return prev;
        },
        {} as { [address: string]: Passport }
      );
      console.timeEnd("fetching balances for all countries");

      const multi = r.multi();
      let updated = false;

      Object.entries(newState).forEach(([address, passport]) => {
        const last = lastState[address];
        if (!last || last.co2 !== passport.co2) {
          updated = true;
          console.log(
            `co2 for ${address} changed: ${(last && last.co2) ||
              "not set"} => ${passport.co2}`
          );
          multi.zadd("leaders:co2", passport.co2, passport.address);
        }
        if (!last || last.trees !== passport.trees) {
          updated = true;
          console.log(
            `trees for ${address} changed: ${(last && last.trees) ||
              "not set"} => ${passport.trees}`
          );
          multi.zadd("leaders:trees", passport.trees, passport.address);
        }
        if (!last || last.country !== passport.country) {
          updated = true;
          console.log(
            `player ${address} changed country (or is seen for the first time): ${(last &&
              last.country) ||
              "not set"} => ${passport.country}`
          );
          multi.hmset(
            `player:${address}`,
            "countryId",
            passport.country,
            "name",
            (playerNames[address] || { name: "Mr. Mysterious" }).name
          );
        }
      });

      if (updated) {
        const goeBalance = await getGOEBalance();
        console.time("updating state on redis");
        multi.set("lastupdate", now);
        const e: Array<string | number> = [];
        const t: Array<string | number> = [];
        Object.entries(emissionsByCountry).forEach(([country, co2]) => {
          const countryTrees = treesByCountry[country] || 0;
          const netCO2 = co2 - countryTrees;
          if (netCO2 !== netCO2Balances[country]) {
            console.log(
              `balance for ${country} was ${
                netCO2Balances[country]
              }, and now is ${netCO2}`
            );
            multi.zadd(`history:netco2:${country}`, now, `${now}:${netCO2}`);
          }
          e.push(country, co2);
          t.push(country, countryTrees);
        });
        multi.hmset("countries:co2", e);
        multi.hmset("countries:trees", t);
        multi.set("laststate", JSON.stringify(newState));
        multi.set("goe", goeBalance.toString());
        multi.exec(() => console.timeEnd("updating state on redis"));
      }

      const trees = Object.values(newState)
        .filter(p => p.trees > 0)
        .sort((p1, p2) =>
          p1.trees > p2.trees ? -1 : p1.trees === p2.trees ? 0 : 1
        )
        .map(p => [p.address, p.trees] as [string, number]);

      const emissions = Object.values(newState)
        .filter(p => p.co2 > 0)
        .sort((p1, p2) => (p1.co2 > p2.co2 ? -1 : p1.co2 === p2.co2 ? 0 : 1))
        .map(p => [p.address, p.co2] as [string, number]);

      resolve({
        updated,
        emissions,
        trees,
        emissionsByCountry,
        treesByCountry
      });
    });
  });

const getGOEBalance = async () => {
  console.time("fetching goe balance for earth contract");
  const balance = await earthContract.methods
    .balanceOf(earthContractAddress)
    .call()
    .catch(e => console.log(e));
  console.timeEnd("fetching goe balance for earth contract");
  return (
    totalGoeMillis - parseInt((balance || "0000000000000000").slice(0, -15), 10)
  );
};

export const handler = async (event: any = {}) => {
  console.log("launched!");
  getLeaderboard().then(leaderboard =>
    console.log(JSON.stringify(leaderboard, null, 2))
  );
  return true;
};

const update = () =>
  getLeaderboard()
    .then(o => console.log(`Stats ${o.updated ? "" : "not "}updated to redis`))
    .catch(e => console.error(e));

console.time("initializing goe contract");
web3 = helpers.extendWeb3(new Web3(web3URL));
const earthContract = new web3.eth.Contract(ierc20, goeAddress);
console.timeEnd("initializing goe contract");

update();
setInterval(update, 10000);
