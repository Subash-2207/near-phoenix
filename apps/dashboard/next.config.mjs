/**
 * Keep Next's production typecheck enabled while using the TypeScript compiler
 * API. Some managed Linux runners swallow stdout from subprocesses, which makes
 * Next's default `tsc --showConfig` CLI parsing fail before typechecking starts.
 */
const nextConfig = {
  experimental: {
    useTypeScriptCli: false,
  },
};

export default nextConfig;
