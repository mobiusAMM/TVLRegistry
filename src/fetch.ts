import { ChainId, Multicall } from "@dahlia-labs/celo-contrib";
import { StablePools } from "@dahlia-labs/mobius-config-registry";
import type { IExchangeInfo } from "@dahlia-labs/stableswap-sdk";
import { calculateSwapPrice } from "@dahlia-labs/stableswap-sdk";
import { Fraction, TokenAmount } from "@dahlia-labs/token-utils";
import type { Interface, Result } from "@ethersproject/abi";
import { getAddress } from "@ethersproject/address";
import { AddressZero } from "@ethersproject/constants";
import type { ContractInterface } from "@ethersproject/contracts";
import { Contract } from "@ethersproject/contracts";
import type { JsonRpcProvider } from "@ethersproject/providers";
import { StaticJsonRpcProvider } from "@ethersproject/providers";
import type { BigNumber } from "ethers";
import * as fs from "fs/promises";
import { chunk } from "lodash";
import invariant from "tiny-invariant";

import LP_ABI from "./abis/LPToken.json";
import MULTICALL_ABI from "./abis/multicall2.json";
import SWAP_ABI from "./abis/Swap.json";
import type { LPToken, Multicall2, Swap } from "./generated";
import {
  getAllCoinGeckoPrices,
  getCoinGeckoPrice,
  getPoolsRegistry,
} from "./poolRegistry";

const MAX_CHUNK = 100;
export interface Call {
  target: string;
  callData: string;
}

// returns the checksummed address if the address is valid, otherwise returns false
export function isAddress(value: string): string | false {
  try {
    return getAddress(value);
  } catch {
    return false;
  }
}

export const parseFunctionReturn = (
  _interface: Interface,
  func: string,
  returnData: string | undefined | unknown
): Result => {
  invariant(typeof returnData === "string", "return data not found");
  return _interface.decodeFunctionResult(func, returnData);
};

// account is optional
export function getContract(
  address: string,
  ABI: ContractInterface,
  provider: JsonRpcProvider
): Contract {
  if (!isAddress(address)) {
    throw Error(`Invalid 'address' parameter '${address}'.`);
  }
  return new Contract(address, ABI, provider);
}

function useContract(
  address: string | undefined,
  ABI: ContractInterface,
  provider: JsonRpcProvider
): Contract | null {
  if (!address || !ABI) return null;
  try {
    return getContract(address, ABI, provider);
  } catch (error) {
    console.error("Failed to get contract", error);
    return null;
  }
}
export function useSwapContract(
  address: string,
  provider: JsonRpcProvider
): Swap | null {
  return useContract(address, SWAP_ABI.abi, provider) as Swap | null;
}
export function useLPContract(
  address: string,
  provider: JsonRpcProvider
): LPToken | null {
  return useContract(address, LP_ABI.abi, provider) as LPToken | null;
}

export function useMulticall(provider: JsonRpcProvider): Multicall2 | null {
  return useContract(
    Multicall[ChainId.Mainnet],
    MULTICALL_ABI,
    provider
  ) as Multicall2 | null;
}

export const fetch = async (): Promise<void> => {
  const provider = new StaticJsonRpcProvider("https://forno.celo.org");

  const multicall = useMulticall(provider);
  const swapContract = useSwapContract(AddressZero, provider);
  const lpContract = useLPContract(AddressZero, provider);

  invariant(multicall && swapContract && lpContract);

  const getMulticallDataChunked = async (calls: Call[]) => {
    const callChunks = chunk(calls, MAX_CHUNK);
    return (
      await Promise.all(
        callChunks.map((c) => multicall.callStatic.aggregate(c))
      )
    ).flatMap((c) => c.returnData);
  };

  const calls: Call[] = StablePools[ChainId.Mainnet].flatMap((p) => [
    {
      target: p.pool.lpToken.address,
      callData: lpContract.interface.encodeFunctionData("totalSupply"),
    },

    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("getTokenBalance", [
        0,
      ]),
    },
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("getTokenBalance", [
        1,
      ]),
    },
  ]);

  const registryData = await getPoolsRegistry();

  const poolData = await getMulticallDataChunked(calls);

  const coinGeckoData = await getAllCoinGeckoPrices(
    StablePools[ChainId.Mainnet].map((d) => d.pool)
  );

  const exchangeInfo: IExchangeInfo[] = chunk(poolData, 3).map((pd, i) => {
    const pool = StablePools[ChainId.Mainnet][i]?.pool;
    invariant(pool);
    const balances = [
      parseFunctionReturn(
        swapContract.interface,
        "getTokenBalance",
        pd[1]
      ) as unknown as BigNumber,
      parseFunctionReturn(
        swapContract.interface,
        "getTokenBalance",
        pd[2]
      ) as unknown as BigNumber,
    ] as [BigNumber, BigNumber];

    const totalSupply = new TokenAmount(
      pool.lpToken,
      parseFunctionReturn(lpContract.interface, "totalSupply", pd[0]).toString()
    );

    const rd = registryData[i];
    invariant(rd);

    return {
      ...rd,
      lpTotalSupply: totalSupply,
      reserves: [
        new TokenAmount(pool.tokens[0], balances[0].toString()),
        new TokenAmount(pool.tokens[1], balances[1].toString()),
      ],
    };
  });

  const tvl = exchangeInfo
    .map((v, i) => {
      const pool = StablePools[ChainId.Mainnet][i]?.pool;
      invariant(pool);

      const price0 = getCoinGeckoPrice(pool.tokens[0], coinGeckoData);
      const price1 = getCoinGeckoPrice(pool.tokens[1], coinGeckoData);

      // token 1 with respect to token 0
      const swapPrice = calculateSwapPrice(v);

      if (!price0 && !price1) return null;
      const price0r = price0 ?? (price1 && price1.divide(swapPrice));
      const price1r = price1 ?? (price0 && price0.multiply(swapPrice));
      invariant(price0r && price1r);
      return price0r
        .multiply(v.reserves[0])
        .add(price1r.multiply(v.reserves[1]));
    })
    .reduce(
      (acc: Fraction, cur) => (cur ? acc.add(cur) : acc),
      new Fraction(0)
    );

  await fs.writeFile("data/pools.json", JSON.stringify(tvl.asNumber, null, 2));

  console.log(`TVL: $${tvl.toFixed(2, { groupSeparator: "," })} `);
};

fetch().catch((err) => {
  console.error(err);
});
