import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@ais/core", "@ais/agent"],
  poweredByHeader: false,
  // lead imports send parsed rows (up to 5,000) to a server action
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};
export default config;
