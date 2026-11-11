
const nextConfig = {
  output: "export",
  basePath: "/near-phoenix",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  experimental: {
    useTypeScriptCli: false,
  },
};

export default nextConfig;
