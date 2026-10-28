import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // koffi is loaded from the app root at SIGTERM (accept queue). Don't bundle it.
  serverExternalPackages: ["koffi"],
};

export default nextConfig;
