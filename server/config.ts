import { randomBytes } from "node:crypto";

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};

const port = Number(env("PORT", "8080"));
const publicUrl = (env("PUBLIC_URL", `http://localhost:${port}`) as string).replace(/\/$/, "");
const mock = env("MOCK_SERBLE", "0") === "1";

export const ONE_COIN = 1n << 24n;

/** Parse a decimal coin amount ("2.5") to raw fixed-point units, as Serble does. */
export function coinsToRaw(coins: string): bigint {
  const [w, f = ""] = coins.trim().split(".");
  const frac = f.slice(0, 12).padEnd(12, "0");
  const scale = 10n ** 12n;
  return BigInt(w || "0") * ONE_COIN + (BigInt(frac) * ONE_COIN + scale / 2n) / scale;
}

export function rawToCoins(raw: bigint | number): string {
  const r = BigInt(raw);
  const whole = r / ONE_COIN;
  const frac = Number(r % ONE_COIN) / Number(ONE_COIN);
  if (frac === 0) return whole.toString();
  return (Number(whole) + frac).toFixed(2).replace(/\.?0+$/, "");
}

export const config = {
  port,
  publicUrl,
  mock,
  dataDir: env("DATA_DIR", "./data") as string,
  serbleApi: (mock ? `http://127.0.0.1:${port}/__mock` : env("SERBLE_API", "https://api.serble.net")!).replace(/\/$/, ""),
  serbleWebsite: (mock ? `${publicUrl}/__mock` : env("SERBLE_WEBSITE", "https://serble.net") as string).replace(/\/$/, ""),
  marketUrl: env("SERBLE_MARKET_URL", "https://market.serble.net") as string,
  clientId: env("SERBLE_CLIENT_ID", mock ? "pollen-mock" : "")!,
  clientSecret: env("SERBLE_CLIENT_SECRET", mock ? "secret" : "")!,
  apiKey: env("SERBLE_API_KEY", mock ? "mock-app-key" : "")!,
  scopes: env("SERBLE_SCOPES", "user_info economy")!,
  sessionSecret: env("SESSION_SECRET") ?? randomBytes(32).toString("hex"),
  seedPackPrice: env("SEED_PACK_PRICE", "10")!,
  seedPackSize: Number(env("SEED_PACK_SIZE", "3")),
  seedPackLuck: Number(env("SEED_PACK_LUCK", "3")),
  /** Extra coins charged on export on top of Serble's item-minting fee. */
  exportFee: env("EXPORT_FEE", "1")!,
  freeSeedHours: Number(env("FREE_SEED_HOURS", "8")),
  freeSeedCap: Number(env("FREE_SEED_CAP", "3")),
  plots: Number(env("PLOTS", "6")),
  /** Growth time multiplier, handy for testing (0.01 makes plants grow 100x faster). */
  growScale: Number(env("GROW_SCALE", "1")),
  itemIconBase: env("ITEM_ICON_BASE", "") as string,
  adminUsers: (env("ADMIN_USERS", "") as string).split(",").map((s) => s.trim()).filter(Boolean),
  trustProxy: env("TRUST_PROXY", "1") === "1",
};

export function assertConfig() {
  const missing = (["clientId", "clientSecret", "apiKey"] as const).filter((k) => !config[k]);
  if (missing.length) {
    console.error(`Missing configuration: ${missing.join(", ")}. Set SERBLE_CLIENT_ID, SERBLE_CLIENT_SECRET and SERBLE_API_KEY, or MOCK_SERBLE=1 for local play.`);
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET not set: sessions will not survive a restart.");
}
