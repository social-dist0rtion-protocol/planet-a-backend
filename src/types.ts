export type Player = {
  avatar?: string;
  name: string;
  event: string;
};

export type Country = {
  id: string;
  name: string;
  color: string;
};

export type LeaderboardResponse = {
  players: { [id: string]: Player };
  trees: Array<[string, number]>;
  emissions: Array<[string, number]>;
  emissionHistory: { [countryId: string]: [string, number] };
  treeHistory: { [countryId: string]: [string, number] };
};
