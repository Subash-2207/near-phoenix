const nextConfig = {
  output: "export",
  basePath: process.env.PHOENIX_ROOT_DEPLOY === "1" ? "" : "/near-phoenix",
  trailingSlash: true,
  images: { unoptimized: true },
};
export default nextConfig;
