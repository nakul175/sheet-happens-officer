import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  serverExternalPackages: ["koffi"],
  partialPrefetching: true,
};

export default nextConfig;
