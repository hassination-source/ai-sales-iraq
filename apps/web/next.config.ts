import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@ais/core"],
  poweredByHeader: false,
};
export default config;
