import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@ais/core", "@ais/agent"],
  poweredByHeader: false,
};
export default config;
