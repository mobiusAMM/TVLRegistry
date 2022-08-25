import type { Fees } from "@dahlia-labs/mobius-config-registry";
import type { IExchange } from "@dahlia-labs/stableswap-sdk";
import type { Token } from "@dahlia-labs/token-utils";
import { Fraction, Percent } from "@dahlia-labs/token-utils";
import axios from "axios";
import JSBI from "jsbi";

const FEE_BASE = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(10));

export interface Registry {
  ampFactor: string;
  paused: boolean;
  fees: {
    trade: string;
    admin: string;
    deposit: string;
    withdraw: string;
  };
}

export const getPoolsRegistry = async (): Promise<
  { ampFactor: JSBI; paused: boolean; fees: Fees }[]
> => {
  const registryURL =
    "https://raw.githubusercontent.com/mobiusAMM/mobius-pool-registry/master/data/pools.json";

  const { data: registryData } = await axios.get<Registry[]>(registryURL);

  return registryData.map((r) => ({
    ampFactor: JSBI.BigInt(r.ampFactor),
    paused: r.paused,
    fees: {
      trade: new Percent(r.fees.trade, FEE_BASE),
      admin: new Percent(r.fees.admin, FEE_BASE),
      deposit: new Percent(r.fees.deposit, FEE_BASE),
      withdraw: new Percent(r.fees.withdraw, FEE_BASE),
    },
  }));
};

const dedupe = (keys: string[]): string[] => {
  const seen = new Set<string>();
  return keys.filter((k) => {
    if (seen.has(k)) {
      return false;
    } else {
      seen.add(k);
      return true;
    }
  });
};

interface CoinGeckoReturn {
  [s: string]: { usd: number };
}

export const getAllCoinGeckoPrices = async (
  pools: IExchange[]
): Promise<CoinGeckoReturn> => {
  const coingeckoIDs = dedupe(
    pools
      .flatMap((p) => p.tokens)
      .map((t) => t.info.extensions?.coingeckoId)
      .filter((id) => !!id) as string[]
  );

  const { data: coinGeckoData } = await axios.get<CoinGeckoReturn>(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoIDs.join(
      ","
    )}&vs_currencies=usd`
  );

  return coinGeckoData;
};

export const getCoinGeckoPrice = (
  token: Token,
  data: CoinGeckoReturn
): Fraction | null => {
  const id = token.info.extensions?.coingeckoId;

  if (!id) return null;

  const price = data[id]?.usd;

  return price ? new Fraction(Math.round(price * 10 ** 6), 10 ** 6) : null;
};
